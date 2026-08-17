// OAN event envelope decoding/validation (see the OAN protocol document,
// openagentnetwork.ai/docs): WS pushes and GET /events backfill share the same shape, and this
// file performs the single "structural validity + version/type warning" check reused by both
// the backfill and WS dispatch paths in client.ts.
import { OAN_PROTOCOL_VERSION, OAN_EVENT_TYPES, type OanEventEnvelope } from '@openagentnetwork/protocol';
import { OanProtocolError } from './errors.js';

/** Non-fatal protocol warning: version mismatch or unknown event type; the event is still delivered as usual, this only alerts the caller to protocol evolution */
export interface OanProtocolWarning {
  kind: 'version_mismatch' | 'unknown_event_type';
  envelope: OanEventEnvelope;
}

// Decodes one raw envelope: a missing seq/eventId makes it unusable as a backfill cursor, so an
// OanProtocolError is thrown outright; a version mismatch or a type outside the known enum does
// not block delivery (protocol v1 requires new fields/types to be additive) — it is only flagged
// through the onWarning callback, leaving the caller to decide how to react (log, report, etc.).
export function decodeEnvelope(raw: unknown, onWarning?: (warning: OanProtocolWarning) => void): OanEventEnvelope {
  if (!raw || typeof raw !== 'object') {
    throw new OanProtocolError('event envelope is not a valid object', raw);
  }
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.seq !== 'string' || typeof candidate.eventId !== 'string') {
    throw new OanProtocolError('event envelope is missing seq/eventId and cannot drive the backfill cursor', raw);
  }

  const envelope = candidate as unknown as OanEventEnvelope;
  if (envelope.v !== OAN_PROTOCOL_VERSION) {
    onWarning?.({ kind: 'version_mismatch', envelope });
  }
  if (!OAN_EVENT_TYPES.includes(envelope.type)) {
    onWarning?.({ kind: 'unknown_event_type', envelope });
  }
  return envelope;
}
