import type { OanEventType, OanMessageSource } from './events.js';

/**
 * OAN protocol version, incremented on structural changes to OanEventEnvelope.
 */
export const OAN_PROTOCOL_VERSION = 1;

/**
 * Socket.IO namespace where the OAN capability is mounted.
 */
export const OAN_WS_NAMESPACE = '/oan';

/**
 * Socket.IO event name used for pushes on the OAN namespace.
 */
export const OAN_WS_EVENT = 'oan:event';

/**
 * OAN event envelope: WS pushes and GET /events backfill share this exact structure.
 * Fields mirror the server's persisted event record and are consumed by external
 * connectors (OpenClaw, Hermes, and others).
 */
export interface OanEventEnvelope {
  /** Protocol version; see OAN_PROTOCOL_VERSION for the current value */
  v: number;
  /** Server-side monotonically increasing event sequence number (stringified bigint), used as the backfill cursor */
  seq: string;
  /** Unique event id */
  eventId: string;
  type: OanEventType;
  /** goferId, identifying a Gofer under this account */
  goferId?: string;
  chatId?: string;
  threadId?: string;
  conversationId?: string;
  source: OanMessageSource;
  /**
   * Response format/value constraints. The frozen v1 shape is documented in the
   * OAN protocol document (openagentnetwork.ai/docs); typed unknown here so this
   * package stays dependency-free, leaving consumers to narrow it as needed.
   */
  responseConstraints?: unknown;
  /** When a response is expected, names the REST endpoint to call */
  reply?: { method: 'POST'; path: string };
  /** The platform's hosted web page for this event, when the deployment provides one */
  webUrl?: string;
  payload: Record<string, unknown>;
  /** ISO timestamp string */
  createdAt: string;
}

/** Summary counts for GET /events/unresolved: the data source for takeover-note copy */
export interface OanUnresolvedSummary {
  /** Number of questions that were asked but remain unanswered */
  pendingQuestions: number;
  /** Number of distinct Gofers those questions came from */
  goferCount: number;
  /** Number of pending decision items (match requests + pairings awaiting confirmation) */
  decisions: number;
}

/** Account-takeover digest: outstanding items are returned as raw event envelopes, so connectors run them through the same ingestion pipeline as live events */
export interface OanUnresolvedDigest {
  /** Ascending by original seq */
  events: OanEventEnvelope[];
  summary: OanUnresolvedSummary;
}
