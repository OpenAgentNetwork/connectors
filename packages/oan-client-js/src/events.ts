// OAN event backfill module (see the OAN protocol document, openagentnetwork.ai/docs):
// GET /events?since=&limit=. This is the only cursor endpoint with global backfill semantics;
// the connect/reconnect main loop in client.ts is driven by this module.
import type { OanEventEnvelope, OanUnresolvedDigest } from '@openagentnetwork/protocol';
import { OAN_REST_PATHS } from '@openagentnetwork/protocol';
import { oanRequest, type AuthMode } from './rest-client.js';

// Fetches one page of events in ascending seq order; omitting since or passing '0' means backfill from the start, limit defaults to 50 with a cap of 200 (server-enforced)
export async function listEventsSince(
  baseUrl: string,
  auth: AuthMode,
  since?: string,
  limit?: number,
): Promise<OanEventEnvelope[]> {
  return oanRequest<OanEventEnvelope[]>(baseUrl, OAN_REST_PATHS.events, {
    method: 'GET',
    auth,
    query: { since, limit },
  });
}

// This account's current max event seq ("0" when there are no events): a brand-new connector
// initializes its cursor to "now" on first connect, so the account's entire event history is
// not replayed as new messages (historical context is fetched on demand via the REST history endpoints)
export async function getEventsCursor(baseUrl: string, auth: AuthMode): Promise<{ seq: string }> {
  return oanRequest<{ seq: string }>(baseUrl, OAN_REST_PATHS.eventsCursor, {
    method: 'GET',
    auth,
  });
}

// Account-takeover triage: items still awaiting a user answer (re-fetch surface of raw event
// envelopes). Called by the connector's deterministic layer after a fresh instance (no local
// cursor) first connects, to seed the outstanding items into the local inbox — the agent reads
// only locally and never touches this endpoint
export async function listUnresolvedEvents(baseUrl: string, auth: AuthMode): Promise<OanUnresolvedDigest> {
  return oanRequest<OanUnresolvedDigest>(baseUrl, OAN_REST_PATHS.eventsUnresolved, {
    method: 'GET',
    auth,
  });
}
