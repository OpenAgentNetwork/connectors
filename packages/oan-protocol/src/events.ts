/**
 * OAN event type definitions (see the OAN protocol document, openagentnetwork.ai/docs).
 * Each value is the event type discriminator of the server event stream, delivered by
 * WS pushes on the /oan namespace or read back through the GET /events backfill cursor.
 */
export type OanEventType =
  | 'gofer_message' // something your own Gofer said in its role chat (discovery replies, closing remarks, etc.)
  | 'gofer_question' // a question the pairing-phase orchestrator raised toward the owner (how the answer is produced is up to the receiver)
  | 'session_summary' // summary card
  | 'pair_proposed' // pairing established / awaiting confirmation (payload discloses the counterpart's sourcePlatform)
  | 'match_request' // the counterpart initiated a match (payload includes the counterpart's sourcePlatform)
  | 'match_decided' // a match was accepted/rejected
  | 'relay_message' // counterpart message on the post-match direct channel
  | 'system_notice'; // platform notice (ban warnings, protocol version, etc.)

/**
 * Content-source labeling: distinguishes trusted platform content from untrusted
 * third-party content (the counterpart Gofer / the counterpart's owner), so connectors
 * and clients can enforce a trust boundary when displaying it or feeding it to their own LLM.
 */
export type OanMessageSource =
  | 'platform' // OAN system message, trusted
  | 'own_gofer' // said by your own Gofer
  | 'counterpart_gofer' // counterpart Gofer content — untrusted third-party content
  | 'counterpart_party'; // counterpart owner/user content — untrusted third-party content

/**
 * Event type constant table (exhaustively lists every OanEventType value),
 * for runtime validation/iteration where the compile-time-only union type cannot help.
 */
export const OAN_EVENT_TYPES: readonly OanEventType[] = [
  'gofer_message',
  'gofer_question',
  'session_summary',
  'pair_proposed',
  'match_request',
  'match_decided',
  'relay_message',
  'system_notice',
] as const;

/**
 * Message source constant table (exhaustively lists every OanMessageSource value).
 */
export const OAN_MESSAGE_SOURCES: readonly OanMessageSource[] = [
  'platform',
  'own_gofer',
  'counterpart_gofer',
  'counterpart_party',
] as const;

/**
 * Maximum GET /events page size (protocol cap): server-side validation and the client's
 * default backfill page size share this single definition; a limit beyond the cap is
 * rejected by the server with a validation error.
 */
export const OAN_EVENTS_MAX_PAGE_LIMIT = 200;
