// OAN connection management: wraps the OanClient connection lifecycle, converts the event
// stream (see the OAN protocol document, openagentnetwork.ai/docs, §5) into inbound message
// drafts delivered to the adapter, and maintains the "pending reply targets" the outbound
// router needs (PendingReplyTracker, see outbound-router.ts). The contract option passes the
// per-message contract's host wording slots through to inbound-mapping.
import { OanClient, type AuthMode, type OanClientInfo } from '@openagentnetwork/client-js';
import { createFileCursorStore } from './cursor-store.js';
import {
  mapEnvelopeToInboundMessage,
  type InboundMessageDraft,
  type OanInboundContractOptions,
} from './inbound-mapping.js';
import { PendingReplyTracker } from './outbound-router.js';

/**
 * The minimal interface send-text.ts / media.ts depend on — declaring only the methods the
 * outbound and inbound attachment paths actually call (rather than the full
 * gofers/matchRequests/conversations/attachments namespaces), and an interface rather than
 * the concrete class so unit tests can pass plain-object mocks.
 */
export interface OanConnectionHandle {
  readonly baseUrl: string;
  readonly authMode: AuthMode;
  readonly client: {
    gofers: Pick<OanClient['gofers'], 'sendMessage'>;
    matchRequests: Pick<OanClient['matchRequests'], 'decide'>;
    conversations: Pick<OanClient['conversations'], 'sendMessage'>;
    // Three uploads (outbound) + two redemptions (inbound), see media.ts:
    // signed-URL redemption splits by context into the conversation and thread endpoints,
    // whose semantics are not interchangeable
    attachments: Pick<
      OanClient['attachments'],
      | 'uploadGoferAttachment'
      | 'uploadGoferPhoto'
      | 'uploadConversationAttachment'
      | 'getConversationAttachmentUrl'
      | 'getThreadCounterpartAttachmentUrl'
    >;
  };
  readonly pendingReplies: PendingReplyTracker;
}

export interface OanConnectionOptions {
  baseUrl: string;
  apiKey: string;
  /** Path of the replay-cursor persistence file, resolved by the adapter (state-directory conventions differ across hosts) */
  stateFilePath: string;
  /**
   * This connector's package name and installed version, declared at the handshake so the
   * server can tell the account when a newer connector release exists (an install is pinned by
   * its package manager and would otherwise never learn of one). Each adapter supplies its own.
   */
  client?: OanClientInfo;
  deliverInbound: (draft: InboundMessageDraft) => void | Promise<void>;
  /** Host wording slots for the per-message contract (see inbound-mapping.ts); neutral by default */
  contract?: OanInboundContractOptions;
  onError?: (error: unknown) => void;
  onStopped?: (reason: string) => void;
}

/** Connection status snapshot: lets the oan_status tool answer "is the channel actually connected" */
export interface OanConnectionStatusSnapshot {
  /** connect() succeeded and no terminal stop has occurred */
  connected: boolean;
  /** The OanClient's terminal stop reason (retries exhausted, etc.); its presence means the connection is dead and needs intervention */
  stoppedReason?: string;
  /** The most recent connection-layer error (the client reconnects automatically; diagnostic reference only) */
  lastErrorMessage?: string;
  /** Total events received in this connector lifecycle (0 is normal: no Gofer on the account has anything to say yet) */
  eventCount: number;
  /** When the last event arrived (ISO string) */
  lastEventAt?: string;
}

export class OanConnection implements OanConnectionHandle {
  readonly client: OanClient;
  readonly pendingReplies = new PendingReplyTracker();
  readonly baseUrl: string;
  readonly authMode: AuthMode;

  private connected = false;
  private stoppedReason: string | undefined;
  private lastErrorMessage: string | undefined;
  private eventCount = 0;
  private lastEventAt: string | undefined;

  constructor(private readonly options: OanConnectionOptions) {
    this.baseUrl = options.baseUrl;
    this.authMode = { kind: 'apiKey', apiKey: options.apiKey };

    const cursorStore = createFileCursorStore(options.stateFilePath);
    this.client = new OanClient({
      baseUrl: options.baseUrl,
      credentials: { apiKey: options.apiKey },
      ...(options.client ? { client: options.client } : {}),
      restoreCursor: () => cursorStore.restore(),
      persistCursor: (seq) => cursorStore.persist(seq),
      // Wrap to capture state, then pass through to the caller's original callbacks
      onError: (error) => {
        this.lastErrorMessage = error instanceof Error ? error.message : String(error);
        options.onError?.(error);
      },
      onStopped: (reason) => {
        this.connected = false;
        this.stoppedReason = String(reason);
        options.onStopped?.(reason);
      },
    });

    this.client.onEvent((envelope) => {
      this.eventCount += 1;
      this.lastEventAt = new Date().toISOString();
      const draft = mapEnvelopeToInboundMessage(envelope, this.options.contract);
      this.pendingReplies.record(draft.contactId, envelope);
      void this.options.deliverInbound(draft);
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
    this.connected = true;
  }

  disconnect(): void {
    this.connected = false;
    this.client.disconnect();
  }

  statusSnapshot(): OanConnectionStatusSnapshot {
    return {
      connected: this.connected,
      ...(this.stoppedReason !== undefined ? { stoppedReason: this.stoppedReason } : {}),
      ...(this.lastErrorMessage !== undefined ? { lastErrorMessage: this.lastErrorMessage } : {}),
      eventCount: this.eventCount,
      ...(this.lastEventAt !== undefined ? { lastEventAt: this.lastEventAt } : {}),
    };
  }
}
