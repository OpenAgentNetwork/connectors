// Pipeline assembly (the heart of this plugin): connection lifecycle (the core
// connection-supervisor with unbounded reconnects), the single-machine two-instance lock,
// inbound intake (event → inbox → wake request), the takeover sweep, media file IO,
// outbound delivery (oan_reply / file attachments), and tool dependency wiring.
//
// Lifecycle iron rule: the host's 5-second kill timer is only
// cleared after dispose succeeds — sockets/timers left open mean the process hangs forever.
// stop() must close every handle and return fast.
import { mkdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  conversationIdFromContactId,
  createFileCursorStore,
  createInboundMediaStager,
  goferIdFromContactId,
  intakeInboundDraft,
  listPendingInboxItems,
  markInboxItemsHandled,
  markTakeoverPending,
  parseDecisionIntent,
  runTakeoverIfPending,
  sendOanFile,
  sendOanText,
  superviseOanConnection,
  sweepPendingReminders,
  OanConnection,
  PendingExchangeLedger,
  OAN_MEDIA_MAX_BYTES,
  type InboundMessageDraft,
  type OanConnectionHandle,
  type OanConnectionOptions,
  type OanConnectionStatusSnapshot,
  type OanCoreToolDeps,
  type OanHostHints,
  type OanInboxItemView,
  type OanMediaHostIo,
  type OanPairedCredentials,
  type OanSupervisorTransition,
} from '@openagentnetwork/connector-core';
import {
  sendConversationMessage,
  sendGoferMessage,
  type AuthMode,
  type OanUnresolvedDigest,
} from '@openagentnetwork/client-js';
import { readOanCredentials, writeOanCredentials } from './credentials.js';
import { OAN_DSH_CLIENT_INFO } from './identity.js';
import type { HostCredentialProvider, HostLogger } from './host-types.js';
import type { OanStatePaths } from './state.js';
import type { OanWakeManager } from './wake.js';

/** Default first-connection wait: the cap on oan_pair waiting for the first connection result (used for the supervisor's first transition) */
export const OAN_FIRST_CONNECT_TIMEOUT_MS = 20_000;

/** Outcome of oan_pair / a credential hot-reload */
export type OanPairApplyOutcome =
  | { kind: 'already-connected' }
  | { kind: 'connected' }
  | { kind: 'failed'; reason: string };

/**
 * Minimal connection surface: the default factory produces OanConnection (core); tests can
 * inject a stand-in. client.events.listUnresolved is the pull endpoint for the takeover
 * sweep (an addition beyond OanConnectionHandle).
 */
export interface OanRuntimeConnection extends OanConnectionHandle {
  connect(): Promise<void>;
  disconnect(): void;
  statusSnapshot(): OanConnectionStatusSnapshot;
  readonly client: OanConnectionHandle['client'] & {
    events: { listUnresolved(): Promise<OanUnresolvedDigest> };
  };
}

export interface OanRuntimeDeps {
  paths: OanStatePaths;
  defaultBaseUrl: string;
  /** Size cap on outbound/inbound attachments (already the smaller of this and the OAN server's 10MB hard limit) */
  mediaMaxBytes: number;
  credentials: HostCredentialProvider;
  wake: Pick<OanWakeManager, 'requestInboxWake' | 'deliverNote' | 'markWakeConsumed'>;
  /** Callback for when the inbox pending count may have changed (badge refresh, wired in index.ts) */
  onPendingMaybeChanged?: () => void;
  log: HostLogger;
  // ---- test injection ----
  now?: () => number;
  pid?: number;
  isPidAlive?: (pid: number) => boolean;
  createConnection?: (options: OanConnectionOptions) => OanRuntimeConnection;
  supervisorTuning?: { baseDelayMs?: number; maxDelayMs?: number; stableAfterMs?: number };
}

export class OanRuntime {
  private readonly ledger: PendingExchangeLedger;
  private currentCredentials: OanPairedCredentials | undefined;
  private connection: OanRuntimeConnection | undefined;
  private abort: AbortController | undefined;
  private supervisorDone: Promise<unknown> | undefined;
  private lockBlockedBy: number | undefined;
  private lockTimer: ReturnType<typeof setInterval> | undefined;
  private reminderTimer: ReturnType<typeof setInterval> | undefined;
  private firstConnectWaiters: Array<(outcome: { connected: boolean; reason?: string }) => void> = [];
  private started = false;
  private stopped = false;

  constructor(private readonly deps: OanRuntimeDeps) {
    this.ledger = new PendingExchangeLedger(deps.paths.ledgerPath);
  }

  /**
   * Startup: ledger recovery → credential snapshot → two-instance lock → timers → (when
   * paired) the connection supervision loop. When the lock is held elsewhere, no connection
   * is opened (structural protection against two connectors double-replying the same
   * account); the reason is surfaced through oan_status.
   */
  async start(): Promise<void> {
    this.started = true;
    await mkdir(this.deps.paths.stateDir, { recursive: true });
    await this.ledger.load();
    this.currentCredentials = await readOanCredentials(this.deps.credentials, this.deps.defaultBaseUrl);

    const lock = await claimInstanceLock(this.deps.paths.lockPath, {
      pid: this.pid(),
      now: this.now(),
      isPidAlive: this.deps.isPidAlive ?? defaultIsPidAlive,
    });
    if (!lock.claimed) {
      this.lockBlockedBy = lock.holderPid;
      this.deps.log.warn(
        `oan: another dsh process (pid ${lock.holderPid}) already holds the OAN connection on this machine — ` +
          'this instance will not open a second one.',
      );
      return;
    }
    // Heartbeat and reminder timers are unref'd: even if stop is bypassed, they never keep
    // the process alive (defense in depth for the §3.2 red line)
    this.lockTimer = setInterval(() => {
      void touchInstanceLock(this.deps.paths.lockPath, this.pid()).catch(() => {});
    }, OAN_LOCK_TOUCH_MS);
    this.lockTimer.unref?.();
    this.reminderTimer = setInterval(() => {
      void sweepPendingReminders(
        this.ledger,
        (note) => (this.deps.wake.deliverNote(note, 'oan:remind') ? 'queued' : 'failed'),
        this.now(),
      );
    }, 60_000);
    this.reminderTimer.unref?.();

    if (!this.currentCredentials) {
      this.deps.log.info('oan: not paired yet — waiting for the oan_pair tool.');
      return;
    }
    this.startConnectionLoop(this.currentCredentials);
  }

  /** Shutdown: abort the supervision loop, disconnect, clear timers, release the lock. Must return fast (§3.2) */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.lockTimer) clearInterval(this.lockTimer);
    if (this.reminderTimer) clearInterval(this.reminderTimer);
    this.lockTimer = undefined;
    this.reminderTimer = undefined;
    await this.stopConnection();
    if (this.lockBlockedBy === undefined) {
      await releaseInstanceLock(this.deps.paths.lockPath, this.pid()).catch(() => {});
    }
  }

  /**
   * Idempotent handling of credentials/updated: when the credential file is rewritten
   * externally (including oan_pair's own set), compare against the in-process snapshot —
   * no action on identical values, restart the connection on a change.
   */
  async handleCredentialsUpdated(): Promise<void> {
    const next = await readOanCredentials(this.deps.credentials, this.deps.defaultBaseUrl);
    if (sameCredentials(this.currentCredentials, next)) return;
    this.currentCredentials = next;
    await this.stopConnection();
    if (next && this.canRunConnection()) this.startConnectionLoop(next);
  }

  /**
   * The oan_pair landing path: idempotent short-circuit (same credentials and already
   * connected → no restart) → writability pre-check + set both refs → restart the
   * connection on the spot → wait for the first connection result. The key never enters any
   * returned text.
   */
  async applyPairedCredentials(credentials: OanPairedCredentials): Promise<OanPairApplyOutcome> {
    if (sameCredentials(this.currentCredentials, credentials) && this.isConnected()) {
      return { kind: 'already-connected' };
    }
    await writeOanCredentials(this.deps.credentials, credentials);
    // Update the snapshot before restarting: the credentials/updated event triggered by set
    // becomes a no-op through the same-value comparison
    this.currentCredentials = credentials;
    if (this.lockBlockedBy !== undefined) {
      return {
        kind: 'failed',
        reason:
          `credentials stored, but another dsh process (pid ${this.lockBlockedBy}) holds the OAN connection ` +
          'on this machine — stop that process and restart this one',
      };
    }
    const first = this.awaitFirstConnect();
    await this.stopConnection();
    if (this.canRunConnection()) this.startConnectionLoop(credentials);
    const outcome = await first;
    return outcome.connected ? { kind: 'connected' } : { kind: 'failed', reason: outcome.reason ?? 'unknown' };
  }

  /** Dependency wiring for the tool layer (the 8 core tools) (see tools.ts for the budget and hostHints notes) */
  buildCoreToolDeps(hostHints: OanHostHints, toolResultBudget: number): OanCoreToolDeps {
    return {
      // Read the in-process credential snapshot synchronously: the host's resolve is async,
      // and the snapshot is kept fresh from three places — start / oan_pair /
      // credentials-updated (the watcher debounces at 100ms); credentials sourced from
      // environment variables are immutable for the process lifetime, so the snapshot
      // cannot go stale
      readCredentials: () => this.currentCredentials,
      // DSH tools execute inside the plugin process → read the supervisor's in-process
      // snapshot directly; the cold-instance liveness fallback is not wired
      readConnectionStatus: () => this.connection?.statusSnapshot(),
      markEscalated: (contactId) => {
        void this.ledger.markEscalated(contactId);
        return true;
      },
      fetchInbox: async (): Promise<OanInboxItemView[]> => {
        // Fetching consumes the wake: subsequent inbound events trigger a fresh wake (the
        // coalescing window closes here)
        await this.deps.wake.markWakeConsumed();
        return (await listPendingInboxItems(this.deps.paths.inboxPath)).map((item) => ({
          eventId: item.eventId,
          contactId: item.contactId,
          kind: item.kind,
          body: item.body,
          ...(item.mediaPaths ? { mediaPaths: item.mediaPaths } : {}),
          receivedAt: item.receivedAt,
        }));
      },
      consumeInbox: async (eventIds) => {
        await markInboxItemsHandled(this.deps.paths.inboxPath, eventIds);
        this.deps.onPendingMaybeChanged?.();
      },
      deliverToContact: (contactId, text) => this.deliverToContact(contactId, text, hostHints),
      deliverFileToContact: (contactId, filePath, caption) =>
        this.deliverFileToContact(contactId, filePath, caption),
      toolResultBudget,
      hostHints,
    };
  }

  /** DSH-specific extra lines for oan_status (appended after the core status output); returns an empty array when there is nothing to add */
  statusExtras(): string[] {
    const lines: string[] = [];
    if (this.lockBlockedBy !== undefined) {
      lines.push(
        `Note: another dsh process (pid ${this.lockBlockedBy}) on this machine already holds the OAN ` +
          'connection, so this instance did not open a second one (two connectors would double-reply the same ' +
          'account). Stop the other process and restart this dsh to take over.',
      );
      return lines;
    }
    if (!this.isConnected()) {
      lines.push(
        'Host notes: a headless dsh run (single-task mode) exits after one turn and cannot receive OAN events — ' +
          'a resident profile such as `npx @deepseek-ai/dsh web` is required for the connection to stay up. If oan_* tools are ' +
          "missing for some agent, that agent's tool allow mask was compiled before this plugin loaded — " +
          'restrict after the plugin loads or include the oan_* names in the mask.',
      );
    }
    return lines;
  }

  isConnected(): boolean {
    return this.connection?.statusSnapshot().connected === true;
  }

  readCredentialsSnapshot(): OanPairedCredentials | undefined {
    return this.currentCredentials;
  }

  /**
   * The oan_reply return path: with a live connection, go through sendOanText (which keeps
   * pending-decision routing and ledger settlement); when the connection is not running in
   * this process, use the credentials for a direct REST call — pending decisions are not
   * visible there, so a bare yes/no is honestly refused rather than mis-sent as an ordinary
   * message.
   */
  private async deliverToContact(
    contactId: string,
    text: string,
    hostHints: OanHostHints,
  ): Promise<{ via: 'connection' | 'rest' }> {
    if (!conversationIdFromContactId(contactId) && !goferIdFromContactId(contactId)) {
      throw new Error(`Cannot send to a non-Gofer OAN contact: ${contactId}`);
    }
    const connection = this.connection;
    if (connection) {
      await sendOanText(connection, contactId, text);
      void this.ledger.close(contactId);
      return { via: 'connection' };
    }
    const credentials = this.currentCredentials;
    if (!credentials) {
      throw new Error(`OpenAgentNetwork is not paired yet. ${hostHints.howToPair}`);
    }
    const auth: AuthMode = { kind: 'apiKey', apiKey: credentials.apiKey };
    const conversationId = conversationIdFromContactId(contactId);
    if (conversationId) {
      await sendConversationMessage(credentials.baseUrl, auth, conversationId, text);
      void this.ledger.close(contactId);
      return { via: 'rest' };
    }
    if (parseDecisionIntent(text) !== null) {
      throw new Error(
        'This looks like a yes/no decision, but the pending-decision state is only visible to the live ' +
          'connection, which is not running in this process. Check oan_status, wait for the connection, then retry.',
      );
    }
    await sendGoferMessage(credentials.baseUrl, auth, goferIdFromContactId(contactId) as string, text);
    void this.ledger.close(contactId);
    return { via: 'rest' };
  }

  /** Cross-session file delivery: core sendOanFile (upload + attachment message in one step); settle the ledger on success */
  private async deliverFileToContact(
    contactId: string,
    filePath: string,
    caption?: string,
  ): Promise<{ fileName: string }> {
    const connection = this.connection;
    if (!connection) {
      throw new Error(
        'File delivery needs the live OAN connection, which is not running in this process. ' +
          'Check oan_status and retry once connected.',
      );
    }
    const result = await sendOanFile(connection, this.mediaIo, contactId, filePath, caption, {
      maxBytes: this.deps.mediaMaxBytes,
    });
    void this.ledger.close(contactId);
    return { fileName: result.fileName };
  }

  /**
   * Media file IO (OanMediaHostIo): all protocol semantics live in core media.ts; this only
   * answers "how inbound bytes land on disk and how outbound files are read".
   */
  private readonly mediaIo: OanMediaHostIo = {
    persistInboundBytes: async ({ bytes, name, contactId }) => {
      const dir = path.join(this.deps.paths.mediaDir, sanitizePathSegment(contactId));
      await mkdir(dir, { recursive: true });
      const target = path.join(dir, `${this.now()}-${sanitizePathSegment(name)}`);
      await writeFile(target, bytes);
      return target;
    },
    readOutboundFile: async (filePath) => {
      const resolved = await this.assertOutboundReadable(filePath);
      const data = await readFile(resolved);
      return { bytes: new Uint8Array(data), name: path.basename(resolved) };
    },
  };

  /**
   * Outbound attachment path defense: filePath comes from the model, and reading arbitrary
   * paths would hand the local filesystem to anyone who can talk the model into it. Reject
   * the host home ($DSH_HOME, where the .credentials.yaml credentials live), dot-prefixed
   * key directories, and environment files; the checks run on the realpath, so symlinks
   * cannot bypass them.
   */
  private async assertOutboundReadable(filePath: string): Promise<string> {
    if (!path.isAbsolute(filePath)) {
      throw new Error('filePath must be an absolute path to a file in your workspace.');
    }
    const resolved = await realpath(filePath);
    const dshHome = await realpath(path.dirname(this.deps.paths.stateDir)).catch(() =>
      path.dirname(this.deps.paths.stateDir),
    );
    if (resolved === dshHome || resolved.startsWith(dshHome + path.sep)) {
      throw new Error('Refusing to send files from the dsh home directory (it holds credentials and session data).');
    }
    const SENSITIVE_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.kube']);
    if (resolved.split(path.sep).some((segment) => SENSITIVE_DIRS.has(segment))) {
      throw new Error('Refusing to send files from a credential directory.');
    }
    if (/^\.env(\.|$)/.test(path.basename(resolved))) {
      throw new Error('Refusing to send configuration or environment files.');
    }
    const info = await stat(resolved);
    if (!info.isFile()) {
      throw new Error(`Not a regular file: ${filePath}`);
    }
    return resolved;
  }

  // -------------------------------------------------------------------------
  // Connection supervision loop
  // -------------------------------------------------------------------------

  private canRunConnection(): boolean {
    return this.started && !this.stopped && this.lockBlockedBy === undefined;
  }

  private startConnectionLoop(credentials: OanPairedCredentials): void {
    if (this.abort) return; // already running
    const abort = new AbortController();
    this.abort = abort;
    this.supervisorDone = (async () => {
      // A cursorless first connection = a brand-new instance joining (fresh install / host
      // change / lost state): set the takeover-pending flag; after the first successful
      // connection, pull the account's backlog to seed the inbox (see the connected branch
      // of handleTransition)
      if (createFileCursorStore(this.deps.paths.cursorPath).restore() === null) {
        try {
          await markTakeoverPending(this.deps.paths.takeoverPath);
        } catch (error) {
          this.deps.log.warn(`oan: takeover flag write failed (${String(error)}) — backlog sweep may be skipped.`);
        }
      }
      await superviseOanConnection({
        createConnection: (handlers) => this.buildConnection(credentials, handlers),
        abortSignal: abort.signal,
        onTransition: (transition) => this.handleTransition(credentials, transition),
        ...(this.deps.supervisorTuning ?? {}),
      });
    })().catch((error: unknown) => {
      this.deps.log.error(`oan: connection supervisor crashed: ${String(error)}`);
    });
  }

  /** Abort the supervision loop and disconnect; wait a bounded time for the loop to exit (never let stop hang on the network) */
  private async stopConnection(): Promise<void> {
    const abort = this.abort;
    if (!abort) return;
    this.abort = undefined;
    abort.abort();
    this.connection?.disconnect();
    this.connection = undefined;
    const done = this.supervisorDone ?? Promise.resolve();
    this.supervisorDone = undefined;
    await Promise.race([done, boundedDelay(2_000)]);
  }

  /** Build a fresh connection each cycle (client-js contract: a stopped instance must be recreated before connect) */
  private buildConnection(
    credentials: OanPairedCredentials,
    handlers: { onCycleStopped: (reason: string) => void },
  ): OanRuntimeConnection {
    const factory =
      this.deps.createConnection ??
      ((options: OanConnectionOptions) => new OanConnection(options) as OanRuntimeConnection);
    const connection: OanRuntimeConnection = factory({
      baseUrl: credentials.baseUrl,
      apiKey: credentials.apiKey,
      stateFilePath: this.deps.paths.cursorPath,
      // Declared at the handshake so the server can notify this account when a newer plugin ships
      client: OAN_DSH_CLIENT_INFO,
      deliverInbound: async (draft) => {
        await this.intake(connection, draft, { withWake: true });
      },
      onError: (error) => this.deps.log.error(`oan connector error: ${String(error)}`),
      onStopped: (reason) => handlers.onCycleStopped(String(reason)),
    });
    this.connection = connection;
    return connection;
  }

  private handleTransition(credentials: OanPairedCredentials, transition: OanSupervisorTransition): void {
    if (transition.kind === 'connected') {
      this.deps.log.info(`oan: connected to ${credentials.baseUrl}`);
      this.settleFirstConnect({ connected: true });
      // Inbox items may have piled up while disconnected: request a wake on connect (a
      // no-op when the inbox is empty)
      void this.deps.wake.requestInboxWake().catch(() => {});
      this.runTakeover();
      return;
    }
    if (transition.kind === 'reconnect-scheduled') {
      this.deps.log.warn(
        `oan: connection lost (${transition.reason}); reconnect #${transition.attempt} in ` +
          `${Math.round(transition.delayMs / 1000)}s.`,
      );
      this.settleFirstConnect({ connected: false, reason: transition.reason });
      return;
    }
    // auth-dead: the only terminal state needing human intervention (reconnecting would
    // just keep hitting 401; the way out is re-pairing)
    this.deps.log.error(`oan: connection stopped permanently: ${transition.reason}`);
    this.settleFirstConnect({ connected: false, reason: transition.reason });
    this.deps.wake.deliverNote(
      `OpenAgentNetwork connection stopped permanently (${transition.reason}). The stored credential no longer ` +
        'works — re-pair with a fresh pairing code via the oan_pair tool. Tell your user; reconnecting or ' +
        'restarting will not help.',
      'oan:auth-dead',
    );
  }

  /** Takeover sweep: consumes the flag set by a cursorless first connection; on failure the flag stays for the next reconnect to retry; never blocks the connection */
  private runTakeover(): void {
    const connection = this.connection;
    if (!connection) return;
    void runTakeoverIfPending({
      storePath: this.deps.paths.takeoverPath,
      fetchUnresolved: () => connection.client.events.listUnresolved(),
      intake: (draft) => this.intake(connection, draft, { withWake: false }),
      notify: (text, contextKey) => this.deps.wake.deliverNote(text, contextKey),
      wake: () => void this.deps.wake.requestInboxWake().catch(() => {}),
      log: {
        info: (msg) => this.deps.log.info(msg),
        warn: (msg) => this.deps.log.warn(msg),
      },
    })
      .then(() => this.deps.onPendingMaybeChanged?.())
      .catch((error: unknown) => this.deps.log.warn(`oan: takeover sweep crashed: ${String(error)}`));
  }

  /** Intake clerk: stage attachments to disk (via core media redeem/download) → inbox insert (deduplicated by eventId) → wake request */
  private async intake(
    connection: OanRuntimeConnection,
    draft: InboundMessageDraft,
    opts: { withWake: boolean },
  ): Promise<void> {
    const log = {
      info: (msg: string) => this.deps.log.info(msg),
      warn: (msg: string) => this.deps.log.warn(msg),
      error: (msg: string) => this.deps.log.error(msg),
    };
    await intakeInboundDraft(
      {
        inboxPath: this.deps.paths.inboxPath,
        autoReply: 'all',
        stageInboundMedia: createInboundMediaStager(connection, this.mediaIo, {
          maxBytes: this.deps.mediaMaxBytes,
          log,
        }),
        pendingLedger: {
          open: (contactId, sourceEventId, excerpt) => {
            void this.ledger.open(contactId, sourceEventId, excerpt);
          },
        },
        ...(opts.withWake
          ? { requestWake: () => void this.deps.wake.requestInboxWake().catch(() => {}) }
          : {}),
        log,
      },
      draft,
    );
    this.deps.onPendingMaybeChanged?.();
  }

  /** Wait for the first result of the next connection attempt (used by oan_pair); a timeout counts as failure while the connection keeps retrying in the background */
  private awaitFirstConnect(timeoutMs = OAN_FIRST_CONNECT_TIMEOUT_MS): Promise<{ connected: boolean; reason?: string }> {
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        resolvePromise({ connected: false, reason: 'timed out waiting for the first connection attempt' });
      }, timeoutMs);
      timer.unref?.();
      this.firstConnectWaiters.push((outcome) => {
        clearTimeout(timer);
        resolvePromise(outcome);
      });
    });
  }

  private settleFirstConnect(outcome: { connected: boolean; reason?: string }): void {
    for (const waiter of this.firstConnectWaiters.splice(0)) waiter(outcome);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private pid(): number {
    return this.deps.pid ?? process.pid;
  }
}

// ---------------------------------------------------------------------------
// Single-machine two-instance lock: pid + heartbeat timestamp (touched every 60s while running)
// ---------------------------------------------------------------------------

export interface OanLockRecord {
  pid: number;
  touchedAt: string;
}

/** Heartbeat freshness window: past this the lock counts as stale (the holder died or stalled) and can be taken over */
export const OAN_LOCK_FRESH_MS = 180_000;

/** Heartbeat interval */
export const OAN_LOCK_TOUCH_MS = 60_000;

/** Claim the instance lock: refuse a live lock (pid alive and heartbeat fresh); take over stale locks (dead pid / expired heartbeat) directly */
export async function claimInstanceLock(
  lockPath: string,
  opts: { pid: number; now: number; isPidAlive: (pid: number) => boolean },
): Promise<{ claimed: true } | { claimed: false; holderPid: number }> {
  const existing = await readLockRecord(lockPath);
  if (
    existing &&
    existing.pid !== opts.pid &&
    opts.isPidAlive(existing.pid) &&
    opts.now - Date.parse(existing.touchedAt) < OAN_LOCK_FRESH_MS
  ) {
    return { claimed: false, holderPid: existing.pid };
  }
  await writeLockRecord(lockPath, { pid: opts.pid, touchedAt: new Date(opts.now).toISOString() });
  return { claimed: true };
}

/** Heartbeat: only refresh the timestamp while the lock still belongs to us */
export async function touchInstanceLock(lockPath: string, pid: number): Promise<void> {
  const existing = await readLockRecord(lockPath);
  if (!existing || existing.pid !== pid) return;
  await writeLockRecord(lockPath, { pid, touchedAt: new Date().toISOString() });
}

/** Release: only delete our own lock (never delete a taker-over's fresh lock by mistake) */
export async function releaseInstanceLock(lockPath: string, pid: number): Promise<void> {
  const existing = await readLockRecord(lockPath);
  if (!existing || existing.pid !== pid) return;
  await unlink(lockPath).catch(() => {});
}

async function readLockRecord(lockPath: string): Promise<OanLockRecord | undefined> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, 'utf8')) as Partial<OanLockRecord>;
    if (typeof parsed.pid === 'number' && typeof parsed.touchedAt === 'string') {
      return { pid: parsed.pid, touchedAt: parsed.touchedAt };
    }
  } catch {
    // missing/corrupt counts as no lock
  }
  return undefined;
}

async function writeLockRecord(lockPath: string, record: OanLockRecord): Promise<void> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  await writeFile(lockPath, JSON.stringify(record), 'utf8');
}

/** pid liveness probe: signal 0; EPERM = the process exists but we lack permission, which also counts as alive */
function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Bounded delay (unref'd: never keeps the process alive) */
function boundedDelay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms);
    timer.unref?.();
  });
}

/** Sanitize a path segment: narrow the character set and cap the length before a contact ID / peer-chosen filename enters a local path */
function sanitizePathSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  return cleaned.length > 0 ? cleaned : 'file';
}

function sameCredentials(a: OanPairedCredentials | undefined, b: OanPairedCredentials | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.apiKey === b.apiKey && a.baseUrl === b.baseUrl;
}
