// OAN connector client (see the OAN protocol document, openagentnetwork.ai/docs): one OanClient
// instance encapsulates, for one set of account credentials, the full lifecycle of
// "cursor persistence → catch-up backfill on reconnect → live WS events", plus every business REST endpoint.
// The SDK itself never writes credentials or cursors to disk — persistence is delegated to the
// caller via persistCursor/restoreCursor.
import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';
import {
  OAN_EVENTS_MAX_PAGE_LIMIT,
  OAN_WS_EVENT,
  OAN_WS_NAMESPACE,
  type OanClientInfo,
  type OanEventEnvelope,
  type OanEventType,
} from '@openagentnetwork/protocol';
import { decodeEnvelope, type OanProtocolWarning } from './envelope.js';
import { getEventsCursor, listEventsSince, listUnresolvedEvents } from './events.js';
import { createGofer, listGofers, sendGoferMessage, getGoferChatMessages, deleteGofer } from './gofers.js';
import { createMatchRequest, decideMatchRequest } from './match-requests.js';
import { sendConversationMessage, getConversationMessages } from './conversations.js';
import { listApiKeys, revokeApiKey } from './api-keys.js';
import { createPairingCode } from './auth.js';
import {
  uploadGoferAttachment,
  uploadGoferPhoto,
  uploadConversationAttachment,
  getConversationAttachmentUrl,
  getThreadCounterpartAttachmentUrl,
  type OanUploadFile,
} from './attachments.js';

/** Credentials for constructing an OanClient: apiKey (day-to-day connector use) or token (account-level operations, e.g. issuing pairing codes) */
export type OanClientCredentials = { apiKey: string } | { token: string };

export interface OanClientOptions {
  /** OAN API base URL, without the /api/v1 prefix */
  baseUrl: string;
  credentials: OanClientCredentials;
  /**
   * Who this connector is (package name + installed version), declared at the handshake.
   * The server compares it against its published-release registry and notifies the account
   * when a newer connector exists — a connector that declares nothing is never notified,
   * since package managers pin an installed version indefinitely and nothing else on the
   * network reveals that a newer one was published.
   */
  client?: OanClientInfo;
  /** Called each time the event cursor (envelope.seq) advances, so the caller can persist it; if omitted, nothing is persisted (a process restart backfills from the start) */
  persistCursor?: (seq: string) => void | Promise<void>;
  /** Reads the previously persisted cursor at startup; returning null/undefined means backfill from the start */
  restoreCursor?: () => string | null | undefined | Promise<string | null | undefined>;
  /** Backfill page size, default 200 (the protocol cap); larger values mean fewer backfill round-trips */
  backfillPageLimit?: number;
  /**
   * Cap on live WS events buffered while a backfill is in progress, default 1000. On overflow
   * the entire buffer is discarded and, once the current backfill round completes, one extra
   * full paged fetch runs automatically as the safety net (see bufferLiveEvent in client.ts)
   */
  backfillEventBufferLimit?: number;
  /** Fired on events with an unknown type or a mismatched protocol version; the event is still delivered to onEvent/on listeners as usual */
  onProtocolWarning?: (warning: OanProtocolWarning) => void;
  /**
   * Reports exceptions from background flows (reconnect backfill, persistCursor writes) and the
   * terminal error preceding a stop(); never interrupts in-flight event delivery and never
   * throws back to the caller
   */
  onError?: (error: unknown) => void;
  /**
   * Fired when consecutive handshake failures (including manual reconnects after a
   * server-initiated disconnect) reach the reconnectionAttempts cap, or after an
   * account-banned system_notice. By then the client has stopped — it will not initiate any
   * new connection, automatically or manually; the caller must create a new OanClient instance to recover
   */
  onStopped?: (reason: OanClientStopReason) => void;
  /** Connection options passed through to socket.io-client (e.g. tuning reconnect intervals), shallow-merged over the built-in defaults */
  socketOptions?: Partial<ManagerOptions & SocketOptions>;
  /**
   * Retry budget for consecutive handshake failures: covers both the automatic attempts of
   * socket.io's built-in reconnection engine and the manual reconnects triggered by a
   * server-initiated disconnect ('io server disconnect') — both share one counter, reset by
   * any successful handshake. Reaching the cap is treated as terminal failure (typically: the
   * API key was revoked or the account was banned, so the server keeps rejecting handshakes);
   * the client stop()s itself instead of retrying forever against a server that has clearly
   * rejected it. Default 10
   */
  reconnectionAttempts?: number;
}

/** Why stop() was triggered; see OanClientOptions.onStopped */
export type OanClientStopReason = 'account_banned' | 'retries_exhausted';

type OanEventListener = (envelope: OanEventEnvelope) => void;

const DEFAULT_BACKFILL_PAGE_LIMIT = OAN_EVENTS_MAX_PAGE_LIMIT;
const DEFAULT_RECONNECTION_ATTEMPTS = 10;
const DEFAULT_BACKFILL_EVENT_BUFFER_LIMIT = 1000;

export class OanClient {
  // Only these two variants are possible (OanClientCredentials excludes 'none'); the narrowed declaration lets handshakeToken() avoid type assertions
  private readonly authMode: { kind: 'apiKey'; apiKey: string } | { kind: 'jwt'; token: string };
  private readonly listeners = new Set<OanEventListener>();
  private cursor: string | undefined;
  private socket: Socket | undefined;
  // Set to true after the retry cap is reached or an account-banned notice arrives: openSocket() rejects from then on, and no new connection is ever initiated
  private stopped = false;
  // Every event (backfill + live WS) ultimately dispatches through this single serial queue, so dedup checks and cursor advancement can never be scrambled by concurrency
  private dispatchChain: Promise<void> = Promise.resolve();
  // True while a backfill is in progress: live WS events arriving now go only into pendingBuffer
  // instead of dispatching directly, so their seq cannot race the cursor upward and cause smaller
  // seqs in the backfill pages to be misjudged as "already handled" and dropped forever (see runBackfill)
  private buffering = false;
  private pendingBuffer: unknown[] = [];
  private bufferOverflowed = false;
  // Generation counter: tracks how many backfill rounds currently overlap; buffering only closes and the accumulated events only merge once all rounds have finished (count back to zero)
  private backfillDepth = 0;
  private readonly backfillEventBufferLimit: number;

  constructor(private readonly options: OanClientOptions) {
    this.authMode =
      'apiKey' in options.credentials
        ? { kind: 'apiKey', apiKey: options.credentials.apiKey }
        : { kind: 'jwt', token: options.credentials.token };
    this.backfillEventBufferLimit = options.backfillEventBufferLimit ?? DEFAULT_BACKFILL_EVENT_BUFFER_LIMIT;
  }

  /**
   * Connection lifecycle entry point: restoreCursor → connect the /oan WebSocket → on the first
   * 'connect', immediately backfill page by page until a page comes back shorter than limit.
   * The WS is established before the backfill, eliminating the first-connect gap where "events
   * occurring during backfill are lost because the WS is not subscribed yet" — live events
   * produced during backfill still arrive over the WS, get buffered first, and merge into the
   * regular dispatch pipeline in ascending seq order once the backfill completes (see
   * runBackfill), so a delivery order differing from seq order cannot cause spurious drops.
   * Resolves once the backfill has completed and the WS has made its first connection; every
   * subsequent WS reconnect automatically reruns the backfill (protocol document §6).
   */
  async connect(): Promise<void> {
    if (this.cursor === undefined) {
      const restored = await this.options.restoreCursor?.();
      if (restored != null) {
        this.cursor = restored;
      } else {
        // A brand-new connector (no local cursor) starts listening from "now": initialize the
        // cursor to the server's current max seq instead of backfilling everything from 0 —
        // a fresh instance must not replay hours-old conversations as live traffic. Historical
        // context is fetched on demand through the REST history endpoints. If the current
        // cursor cannot be fetched, let connect() fail (the caller retries); never fall back
        // to backfilling from 0
        const { seq } = await getEventsCursor(this.options.baseUrl, this.authMode);
        this.cursor = seq;
        await this.options.persistCursor?.(seq);
      }
    }
    await this.openSocket();
  }

  /**
   * Deliberate disconnect: does not trigger auto-reconnect (unlike disconnects caused by network
   * failure or the server). Clears the internal socket reference so a later connect() genuinely
   * rebuilds a fresh WS connection instead of the stale "this.socket still exists" check
   * mistaking the client for connected and silently delivering nothing. Also clears the backfill
   * buffer — after disconnecting, the socket receives no more live events, so a retained buffer
   * is meaningless and must not be accidentally merged as "this round's" buffered content when
   * some future backfill round finishes
   */
  disconnect(): void {
    this.socket?.disconnect();
    this.socket = undefined;
    this.pendingBuffer = [];
  }

  /** Catch-all event callback: backfill and live WS events are all delivered here, already deduplicated by seq. Returns an unsubscribe function. */
  onEvent(callback: OanEventListener): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /** Convenience listener filtered by event type; semantically equal to filtering by type inside onEvent. Returns an unsubscribe function. */
  on(type: OanEventType, callback: OanEventListener): () => void {
    return this.onEvent((envelope) => {
      if (envelope.type === type) callback(envelope);
    });
  }

  // ---- REST convenience namespaces: bound to this instance's baseUrl/authMode, so callers never pass auth info per call ----

  gofers = {
    create: (input?: { locale?: string; humanReviewTriggers?: string[] }) =>
      createGofer(this.options.baseUrl, this.authMode, input),
    list: () => listGofers(this.options.baseUrl, this.authMode),
    sendMessage: (goferId: string, content?: string, attachmentIds?: string[]) =>
      sendGoferMessage(this.options.baseUrl, this.authMode, goferId, content, attachmentIds),
    getMessages: (goferId: string, since?: string) =>
      getGoferChatMessages(this.options.baseUrl, this.authMode, goferId, since),
    delete: (goferId: string) => deleteGofer(this.options.baseUrl, this.authMode, goferId),
  };

  matchRequests = {
    create: (threadId: string, roleId: string) =>
      createMatchRequest(this.options.baseUrl, this.authMode, threadId, roleId),
    decide: (requestId: string, accept: boolean) =>
      decideMatchRequest(this.options.baseUrl, this.authMode, requestId, accept),
  };

  conversations = {
    getMessages: (conversationId: string, since?: string, limit?: number) =>
      getConversationMessages(this.options.baseUrl, this.authMode, conversationId, since, limit),
    sendMessage: (conversationId: string, content?: string, attachmentIds?: string[]) =>
      sendConversationMessage(this.options.baseUrl, this.authMode, conversationId, content, attachmentIds),
  };

  // Attachment uploads and short-lived signed URL redemption (the protocol document's attachment endpoint family); see attachments.ts
  attachments = {
    uploadGoferAttachment: (goferId: string, file: OanUploadFile) =>
      uploadGoferAttachment(this.options.baseUrl, this.authMode, goferId, file),
    uploadGoferPhoto: (goferId: string, file: OanUploadFile) =>
      uploadGoferPhoto(this.options.baseUrl, this.authMode, goferId, file),
    uploadConversationAttachment: (
      conversationId: string,
      file: OanUploadFile,
      options?: { kind?: 'photo' | 'document'; width?: number; height?: number },
    ) => uploadConversationAttachment(this.options.baseUrl, this.authMode, conversationId, file, options),
    getConversationAttachmentUrl: (conversationId: string, attachmentId: string) =>
      getConversationAttachmentUrl(this.options.baseUrl, this.authMode, conversationId, attachmentId),
    getThreadCounterpartAttachmentUrl: (threadId: string, attachmentId: string) =>
      getThreadCounterpartAttachmentUrl(this.options.baseUrl, this.authMode, threadId, attachmentId),
  };

  apiKeys = {
    list: () => listApiKeys(this.options.baseUrl, this.authMode),
    revoke: (apiKeyId: string) => revokeApiKey(this.options.baseUrl, this.authMode, apiKeyId),
  };

  events = {
    listSince: (since?: string, limit?: number) => listEventsSince(this.options.baseUrl, this.authMode, since, limit),
    cursor: () => getEventsCursor(this.options.baseUrl, this.authMode),
    listUnresolved: () => listUnresolvedEvents(this.options.baseUrl, this.authMode),
  };

  auth = {
    // Only meaningful when this instance was constructed with token (OAN JWT) credentials — the server explicitly rejects API keys on this endpoint
    createPairingCode: () => {
      if (this.authMode.kind !== 'jwt') {
        throw new Error('createPairingCode requires an OanClient constructed with token (OAN JWT) credentials; this instance uses apiKey credentials');
      }
      return createPairingCode(this.options.baseUrl, this.authMode.token);
    },
  };

  // ---- Internal implementation below; not exported ----

  // Establishes/re-establishes the /oan WebSocket connection. The first 'connect' event of this
  // call triggers one backfill round, and the Promise resolves only after that backfill
  // completes; every later 'connect' on the same socket (i.e. a reconnect) reruns the backfill
  // (protocol document §6). Consecutive handshake failures (including the manual reconnects
  // triggered by 'io server disconnect' below) count into connectErrorStreak; reaching the
  // reconnectionAttempts cap stop()s the client rather than retrying forever against a server
  // that has clearly rejected it.
  private openSocket(): Promise<void> {
    if (this.stopped) {
      return Promise.reject(new Error('OanClient has stopped (account banned or reconnection retries exhausted); create a new instance to connect() again'));
    }
    if (this.socket) {
      return Promise.resolve();
    }
    const reconnectionAttemptsLimit = this.options.reconnectionAttempts ?? DEFAULT_RECONNECTION_ATTEMPTS;

    return new Promise((resolve, reject) => {
      // The state below belongs only to this openSocket() call (i.e. this socket instance's
      // lifetime); calling connect() again after disconnect() reaches a brand-new openSocket() call with brand-new state
      let settled = false; // whether this call has already resolved/rejected once (first handshake success/failure)
      let connectErrorStreak = 0; // consecutive handshake failures, reset to zero on success
      // Whether we are inside a reconnect chain that we triggered manually ourselves (see the
      // 'disconnect' handler below): socket.io's built-in reconnection engine only takes
      // responsibility for ordinary drops it detected itself, and will not schedule the next
      // retry for a manual reconnect triggered by 'io server disconnect' — so if that reconnect
      // also fails, we must call connect() again ourselves, or the whole retry loop silently
      // stalls after the first failure and the reconnectionAttempts cap never gets a chance to
      // actually take effect
      let manualRetryInFlight = false;

      const socket = io(this.options.baseUrl + OAN_WS_NAMESPACE, {
        // The declaration is omitted entirely when the caller gave none, so an older server
        // that ignores auth.client sees exactly the handshake it always saw
        auth: {
          token: this.handshakeToken(),
          ...(this.options.client ? { client: this.options.client } : {}),
        },
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: reconnectionAttemptsLimit,
        ...this.options.socketOptions,
      });
      this.socket = socket;

      socket.on(OAN_WS_EVENT, (raw: unknown) => {
        // Account-banned notices take priority over buffering: this is a terminal event and
        // should not be delayed until flush by the usual "buffer while backfill is in progress"
        // rule — buffering can last a whole paged fetch, and nothing is gained by pointlessly
        // delaying a ban notice for that long. On a match, bypass the buffer and deliver
        // immediately (the isAccountBannedNotice check inside dispatch() then triggers stop()).
        // Trade-off: history events still sitting unflushed in the buffer are discarded along
        // with stop() (which clears pendingBuffer), but the account is banned, so continuing to
        // backfill history is pointless, and after stop() the client initiates no further
        // backfill/connection anyway — acceptable
        if (isAccountBannedNotice(raw)) {
          void this.enqueueDispatch(raw).catch((error) => this.options.onError?.(error));
          return;
        }
        // Must not dispatch directly while a backfill is in progress: delivery order follows
        // the call order here, not the events' seq order, so a live event with a larger seq
        // arriving first would push the cursor up and cause smaller-seq history events from the
        // backfill pages to be misjudged as "already handled" when they arrive later, dropped
        // forever (see runBackfill). Buffer first; merge in ascending seq order once the
        // backfill completes
        if (this.buffering) {
          this.bufferLiveEvent(raw);
          return;
        }
        void this.enqueueDispatch(raw).catch((error) => this.options.onError?.(error));
      });

      socket.on('connect', () => {
        connectErrorStreak = 0;
        manualRetryInFlight = false;
        if (!settled) {
          settled = true;
          // WS first, then catch up: live events produced during the backfill are already being
          // listened for at this point (buffered first, then merged in ascending seq order once
          // the backfill completes; see runBackfill), so events in the first-connect gap are
          // not missed just because "the backfill has not finished yet"
          this.runBackfill().then(resolve, reject);
          return;
        }
        // Reconnect: after the network recovers / the server accepts us again, first catch up on history missed while offline, then resume consuming live pushes
        void this.runBackfill().catch((error) => this.options.onError?.(error));
      });

      socket.on('connect_error', (error: Error) => {
        if (!settled) {
          settled = true;
          reject(error);
          return;
        }
        if (this.stopped) return;
        this.options.onError?.(error);
        connectErrorStreak += 1;
        if (connectErrorStreak >= reconnectionAttemptsLimit) {
          this.stop('retries_exhausted', error);
          return;
        }
        // The built-in reconnection engine only auto-reconnects ordinary drops ("transport
        // died, server still reachable"). In the two cases below the engine will not reconnect
        // (again) and the socket goes inactive, so we must take over with manual reconnects or
        // the whole retry loop silently stalls once the socket is inactive, forfeiting both the
        // reconnectionAttempts budget and the onStopped promise:
        //   (a) the manual-reconnect chain triggered by 'io server disconnect' (server-initiated
        //       hard drop, see the disconnect handler below);
        //   (b) after 'transport close' (network blip / ping timeout) the engine auto-reconnects
        //       but the handshake keeps being rejected (typically: the account was banned or the
        //       key revoked while offline) — socket.io treats a handshake-middleware rejection
        //       as terminal, emits connect_error once, then sets socket.active=false and never
        //       retries on its own.
        // The unified criterion is "socket already inactive, or already inside the manual
        // reconnect chain"; once taken over, keep reconnecting manually until the handshake
        // succeeds (streak reset in 'connect') or the budget runs out (stop() above), and let
        // stop() clean up this.socket so the caller can still connect() later (on a new instance)
        if (manualRetryInFlight || !socket.active) {
          manualRetryInFlight = true;
          socket.connect();
        }
      });

      // socket.io-client's built-in reconnection machinery does not auto-reconnect after
      // 'io server disconnect' (a server-initiated drop, e.g. a hard cut after a ban or key
      // revocation) — deliberately, to avoid endless reconnects against a server that clearly
      // rejected you. But the protocol document §6 "catch-up on reconnect" behavior should
      // cover server-initiated drops too, so we trigger one manual reconnect here; that
      // reconnect (and any follow-up manual retries it leads to, see connect_error above) flows
      // through the same connectErrorStreak counter, so a banned account still stops
      // automatically at the cap instead of retrying forever
      socket.on('disconnect', (reason: string) => {
        if (this.stopped) return;
        if (reason === 'io server disconnect') {
          manualRetryInFlight = true;
          socket.connect();
        }
      });
    });
  }

  // Full lifecycle of one backfill round: open buffering → paged fetch (live events arriving
  // meanwhile all go into pendingBuffer first) → run one extra round if the buffer overflowed →
  // once every overlapping round has finished, close buffering and merge the buffered events
  // into dispatch in ascending seq order. backfillDepth is the generation marker: under rapid
  // reconnect jitter the previous round may still be running when the next 'connect' has
  // already triggered a new one; this guarantees only "the last round" actually flushes, so
  // two rounds' buffering/flush state machines never trample each other
  private async runBackfill(): Promise<void> {
    this.backfillDepth += 1;
    this.buffering = true;
    try {
      await this.runBackfillPages();
      // Live events that arrived during a buffer overflow were discarded wholesale (see
      // bufferLiveEvent); this extra full paged fetch is the safety net — anything fetched
      // redundantly is naturally absorbed by the existing seq dedup, never delivered twice
      while (this.bufferOverflowed) {
        this.bufferOverflowed = false;
        await this.runBackfillPages();
      }
    } finally {
      this.backfillDepth -= 1;
      if (this.backfillDepth === 0) {
        const buffered = this.pendingBuffer;
        this.pendingBuffer = [];
        buffered.sort(compareEnvelopeSeq);
        // Key fix: the enqueueDispatch calls for all buffered events must complete within a
        // single synchronous section, uninterrupted by await — enqueueDispatch() itself merely
        // appends the dispatch to the tail of dispatchChain synchronously (awaiting nothing,
        // see its implementation), so the map below runs synchronously end to end without
        // yielding to the event loop. Had this been a for...of with `await enqueueDispatch(...)`
        // per item, control would return to the event loop between items; and once buffering is
        // flipped to false early, a live event arriving mid-flush takes the "dispatch directly"
        // branch — it could get onto dispatchChain ahead of the next buffered event and push the
        // cursor up, so that buffered event, when its turn to dispatch comes, is misjudged by
        // "seq<=cursor" as already handled and dropped forever (zero deliveries; a constructed
        // reproduction lives in the client.test.ts flush chain-slot locking case). Here the
        // chain slots of every buffered item are claimed within one synchronous section first,
        // and only then is buffering flipped — newly arriving live events can naturally only
        // queue behind them, leaving no window to jump the queue
        const dispatches = buffered.map((raw) =>
          // Same as live events on the direct WS path: a single decode/delivery failure only reports the error, never blocks the rest of the buffered events from merging
          this.enqueueDispatch(raw).catch((error) => this.options.onError?.(error)),
        );
        this.buffering = false;
        await Promise.all(dispatches);
      }
    }
  }

  // Paged backfill: GET /events?since=cursor&limit=, until a page comes back shorter than limit (the termination condition recommended by protocol document §6)
  private async runBackfillPages(): Promise<void> {
    const limit = this.options.backfillPageLimit ?? DEFAULT_BACKFILL_PAGE_LIMIT;
    while (!this.stopped) {
      const page = await listEventsSince(this.options.baseUrl, this.authMode, this.cursor, limit);
      for (const raw of page) {
        // A single malformed envelope (rejected by decodeEnvelope, e.g. missing seq/eventId) is
        // only skipped and reported, never aborts the whole backfill round — otherwise one bad
        // envelope would make this while loop throw early, the cursor could never move past it,
        // and every later valid event would be lost. Mirrors the per-item try/except built into
        // the Python SDK's _enqueue_dispatch
        try {
          await this.enqueueDispatch(raw);
        } catch (error) {
          this.options.onError?.(error);
        }
      }
      if (page.length < limit) break;
    }
  }

  // Buffers one live event while a backfill is in progress; past backfillEventBufferLimit the
  // whole buffer is discarded and marked overflowed — no partial eviction like "drop the
  // oldest", which could still break seq continuity; better to let runBackfill run one more
  // full fetch afterwards and rebuild from the authoritative server result
  private bufferLiveEvent(raw: unknown): void {
    if (this.pendingBuffer.length >= this.backfillEventBufferLimit) {
      this.pendingBuffer = [];
      this.bufferOverflowed = true;
      return;
    }
    this.pendingBuffer.push(raw);
  }

  // /oan handshake token: a gofers_-prefixed API key or an OAN JWT is used directly as handshake.auth.token (see the OAN protocol document)
  private handshakeToken(): string {
    return this.authMode.kind === 'apiKey' ? this.authMode.apiKey : this.authMode.token;
  }

  // Single dispatch entry point: decode + dedup by seq + notify listeners + advance the cursor
  // + persist, shared by the backfill and WS paths, and serialized into one chain so
  // concurrency can never reorder cursor advancement (the protocol requires a deterministic
  // "advance the cursor, then call persistCursor" order). The chain exists purely to guarantee
  // execution order and must never carry failure state — a single dispatch() failure must
  // self-heal, or one rejection would permanently skip every queued event that follows via
  // .then()'s short-circuit semantics, silently killing the whole event pipeline.
  private enqueueDispatch(raw: unknown): Promise<void> {
    const result = this.dispatchChain.then(() => this.dispatch(raw));
    this.dispatchChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async dispatch(raw: unknown): Promise<void> {
    const envelope = decodeEnvelope(raw, this.options.onProtocolWarning);

    // Dedup: seq <= local cursor means already handled (backfill and live WS pushes overlapping at a reconnect boundary is normal and allowed by the protocol)
    if (this.cursor !== undefined && BigInt(envelope.seq) <= BigInt(this.cursor)) {
      return;
    }

    for (const listener of this.listeners) {
      try {
        listener(envelope);
      } catch (error) {
        this.options.onError?.(error);
      }
    }

    // Advance the cursor in memory first (dedup always keys off "the latest delivered event");
    // a failed write must not block subsequent events — a persistence failure only affects the
    // backfill starting point after a process restart (a few extra events get backfilled and
    // absorbed by seq dedup, still within the SDK's declared at-least-once semantics), and one
    // persistCursor failure must never drag down the whole event pipeline
    this.cursor = envelope.seq;
    try {
      await this.options.persistCursor?.(this.cursor);
    } catch (error) {
      this.options.onError?.(error);
    }

    // Account banned: the server usually hard-drops this socket right after, but there is no
    // need to wait for the drop or for the retry budget to run out — the notice itself is
    // terminal, and stopping proactively is both faster and more restrained (no further
    // connections toward a server that has already rejected us)
    if (isAccountBannedNotice(envelope)) {
      this.stop('account_banned');
    }
  }

  // Stops the client: closes the current socket and forbids any further automatic/manual
  // reconnects; the reason is reported through onStopped, preceded by one onError report of the
  // corresponding terminal error (the cause if given, otherwise a default description derived from the reason)
  private stop(reason: OanClientStopReason, cause?: unknown): void {
    if (this.stopped) return;
    this.stopped = true;
    this.pendingBuffer = [];

    this.options.onError?.(cause ?? new Error(describeStopReason(reason, this.options.reconnectionAttempts)));
    this.options.onStopped?.(reason);

    this.socket?.disconnect();
    this.socket = undefined;
  }
}

// account_banned is the only system-notice kind that requires the client to stop in response;
// any system_notice.kind the platform adds later is semantically display-only and needs no
// client awareness.
// The parameter is widened to unknown (rather than a strict OanEventEnvelope): dispatch() calls
// this with the decoded envelope, while the early check on raw WS messages (see
// socket.on(OAN_WS_EVENT, ...) in openSocket) calls it with undecoded raw — the latter has not
// been through decodeEnvelope yet (it may lack seq/eventId and other fields), so this does a
// structural check only and never throws on missing fields; both call sites share this single
// piece of logic so the two copies cannot drift apart
function isAccountBannedNotice(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const candidate = raw as Record<string, unknown>;
  if (candidate.type !== 'system_notice') return false;
  const payload = candidate.payload;
  return !!payload && typeof payload === 'object' && (payload as Record<string, unknown>).kind === 'account_banned';
}

function describeStopReason(reason: OanClientStopReason, reconnectionAttempts: number | undefined): string {
  if (reason === 'account_banned') {
    return 'OAN account is banned; the SDK has stopped (no further automatic or manual reconnects)';
  }
  const limit = reconnectionAttempts ?? DEFAULT_RECONNECTION_ATTEMPTS;
  return `OAN consecutive handshake failures reached the retry cap (${limit}); the SDK has stopped`;
}

// Ordering applied before flushing the backfill buffer: ascending by seq, so the existing
// seq<=cursor dedup correctly absorbs whatever overlaps this backfill round. Events have not
// been through decodeEnvelope at this point; entries lacking a valid seq (malformed envelopes)
// all sort to the end — they will be rejected by decodeEnvelope in the later dispatch() anyway,
// so their position never affects the outcome; it only keeps the comparator deterministic
function compareEnvelopeSeq(a: unknown, b: unknown): number {
  const seqA = extractSeqForSort(a);
  const seqB = extractSeqForSort(b);
  if (seqA === null && seqB === null) return 0;
  if (seqA === null) return 1;
  if (seqB === null) return -1;
  if (seqA < seqB) return -1;
  if (seqA > seqB) return 1;
  return 0;
}

function extractSeqForSort(raw: unknown): bigint | null {
  if (!raw || typeof raw !== 'object') return null;
  const seq = (raw as Record<string, unknown>).seq;
  if (typeof seq !== 'string') return null;
  try {
    return BigInt(seq);
  } catch {
    return null;
  }
}
