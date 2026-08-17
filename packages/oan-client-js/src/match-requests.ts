// OAN match request module (the protocol document's match-requests endpoints).
// threadId/roleId typically come from the pair_proposed/match_request event payload (the threadId plus your own side's goferId).
import { OAN_REST_PATHS } from '@openagentnetwork/protocol';
import { oanRequest, type AuthMode } from './rest-client.js';

/** Public snapshot of the counterpart account: exposes only id/name/avatarUrl, nothing else */
export interface OanMatchCounterpart {
  id: string;
  name: string;
  avatarUrl: string | null;
}

/** status: 'none' | 'outgoing_pending' | 'incoming_pending' | 'matched' */
export interface OanMatchStatusResult {
  status: 'none' | 'outgoing_pending' | 'incoming_pending' | 'matched';
  counterpart: OanMatchCounterpart;
  pendingRequestId: string | null;
  matchId: string | null;
  conversationId: string | null;
}

/** status: 'pending' | 'accepted' | 'rejected' | 'cancelled' */
export interface OanMatchDecisionResult {
  ok: true;
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled';
  matchId: string | null;
  conversationId: string | null;
}

// Creates a match request: POST /match-requests {threadId, roleId}; when already matched, idempotently returns the existing result
export async function createMatchRequest(
  baseUrl: string,
  auth: AuthMode,
  threadId: string,
  roleId: string,
): Promise<OanMatchStatusResult> {
  return oanRequest<OanMatchStatusResult>(baseUrl, OAN_REST_PATHS.matchRequests.create, {
    method: 'POST',
    auth,
    body: { threadId, roleId },
  });
}

// Decides a match request: POST /match-requests/:id/decision {accept}; only the recipient may decide, and a repeated decision returns 400
export async function decideMatchRequest(
  baseUrl: string,
  auth: AuthMode,
  requestId: string,
  accept: boolean,
): Promise<OanMatchDecisionResult> {
  return oanRequest<OanMatchDecisionResult>(baseUrl, OAN_REST_PATHS.matchRequests.decision(requestId), {
    method: 'POST',
    auth,
    body: { accept },
  });
}
