// Outbound routing: a host-side human reply → which OAN REST endpoint it should hit.
// Speaking to a Gofer thread goes to POST chat/messages; match decisions and direct
// communication route to their own endpoints by thread context, with the envelope's reply
// field taking routing priority.
import type { OanEventEnvelope } from '@openagentnetwork/client-js';
import { parseDecisionIntent } from './decision-intent.js';

export type RoutedOutboundAction =
  | { kind: 'goferMessage'; goferId: string; content: string }
  | { kind: 'matchDecision'; requestId: string; accept: boolean }
  | { kind: 'pairConfirm'; threadId: string; roleId: string; accepted: boolean }
  | { kind: 'conversationMessage'; conversationId: string; content: string }
  | { kind: 'needsClarification'; hint: string };

/**
 * The current "pending reply target" per contact (thread): records the most recent inbound
 * event carrying a reply field. v1 keeps only the latest pending event per contact — no
 * queueing or expiry management for multiple pending decisions, a known simplification; in
 * conversational match-decision / pairing-confirmation scenarios a new event naturally
 * supersedes the old pending state.
 */
export class PendingReplyTracker {
  private readonly pending = new Map<string, OanEventEnvelope>();

  /** Called after each inbound event; only events carrying a reply field update the pending state */
  record(contactId: string, envelope: OanEventEnvelope): void {
    if (!envelope.reply) return;
    this.pending.set(contactId, envelope);
  }

  peek(contactId: string): OanEventEnvelope | undefined {
    return this.pending.get(contactId);
  }

  /** Called after a decision-class route executes successfully; clears the contact's pending state (a one-shot action, never consumed twice) */
  clear(contactId: string): void {
    this.pending.delete(contactId);
  }
}

/**
 * Outbound routing decision: by default, speak to the Gofer thread (POST chat/messages); when
 * the thread has a pending match decision / pairing confirmation / direct-communication reply
 * target, route to that endpoint first. The reply of gofer_message / gofer_question already
 * points at chat/messages — identical to the default route, so no special case is needed;
 * only match_request / pair_proposed / relay_message change the routing target.
 */
export function routeOutbound(
  goferId: string,
  text: string,
  pending: OanEventEnvelope | undefined,
): RoutedOutboundAction {
  if (!pending) {
    return { kind: 'goferMessage', goferId, content: text };
  }

  switch (pending.type) {
    case 'match_request': {
      const accept = parseDecisionIntent(text);
      const requestId = readString(pending.payload, 'requestId');
      if (accept === null || !requestId) {
        return { kind: 'needsClarification', hint: 'Reply YES to accept or NO to decline this match request.' };
      }
      return { kind: 'matchDecision', requestId, accept };
    }
    case 'pair_proposed': {
      const accepted = parseDecisionIntent(text);
      if (accepted === null || !pending.threadId || !pending.goferId) {
        return { kind: 'needsClarification', hint: 'Reply YES to accept or NO to decline this pairing.' };
      }
      return { kind: 'pairConfirm', threadId: pending.threadId, roleId: pending.goferId, accepted };
    }
    case 'relay_message': {
      if (!pending.conversationId) {
        return { kind: 'goferMessage', goferId, content: text };
      }
      return { kind: 'conversationMessage', conversationId: pending.conversationId, content: text };
    }
    default:
      return { kind: 'goferMessage', goferId, content: text };
  }
}

function readString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}
