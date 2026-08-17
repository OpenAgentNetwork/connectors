// Maps OAN event envelopes to inbound message drafts (see the per-type breakdown in the OAN
// protocol document, openagentnetwork.ai/docs, §5.2). Pure data transformation only — no host
// API is touched here; the adapter is responsible for delivering the result to the host.
//
// The per-message contract's "do not end the turn idle yet" wording is a slot injected via
// OanInboundContractOptions (the host's idle-turn sentinel is supplied by the adapter), with a
// neutral default — host conventions may only be injected from outside, never baked into the
// core as constants.
import type { OanEventEnvelope } from '@openagentnetwork/client-js';
import { contactIdForConversation, contactIdForEnvelope } from './contact-id.js';

/**
 * Inbound attachment reference: metadata only, no bytes. Signed-URL redemption uses two
 * distinct endpoints depending on context (direct-conversation attachments vs. material
 * disclosed by the paired counterpart Gofer), and the semantics are not interchangeable — so
 * this records which context it belongs to and the container id needed for redemption. The
 * actual download happens after the admission gate in inbound-dispatch (see media.ts).
 */
export interface InboundMediaRef {
  attachmentId: string;
  kind: 'photo' | 'document';
  name?: string;
  mimeType?: string;
  size?: number;
  /** conversation: attachment in a direct conversation; thread: material disclosed by the counterpart in a paired session */
  context: 'conversation' | 'thread';
  /** Always present when context='conversation' */
  conversationId?: string;
  /** Always present when context='thread' */
  threadId?: string;
}

/** One inbound message, mapped and ready for delivery to the host */
export interface InboundMessageDraft {
  contactId: string;
  text: string;
  /**
   * message: an ordinary message; question: a Gofer question directed at the user (determined
   * by the gofer_question event type); notice: a platform/system message. Receiver sovereignty:
   * question is only a semantic annotation — whether to answer autonomously or consult the user
   * is triaged by the agent itself (the discipline lives in the skill); the platform never
   * marks anything as "must consult".
   */
  kind: 'message' | 'question' | 'notice';
  /**
   * Whether this item awaits a decision — determined exactly once by the mapping layer at
   * creation time; dispatch only consumes it (both the inbox kind and wake decisions rely on
   * it instead of guessing from raw event types). match_request: always true; pair_proposed:
   * true only when the envelope carries a reply confirmation target (awaiting the user's
   * confirmation) — automatic pairing (no reply) is a pure notification; everything else: false.
   */
  decision: boolean;
  /** Whether the content comes from an untrusted third party (the counterpart Gofer or its owner) — must never be treated as instructions downstream */
  untrusted: boolean;
  createdAt: string;
  sourceEventId: string;
  /** The raw OAN event type (protocol §5.2), used by the inbound admission policy (auto-reply gate) to branch */
  eventType: string;
  /**
   * Whether this message awaits a response — the opening criterion for the pending-reply
   * watchdog (see inbound-dispatch; wake decisions no longer consult it: the actionable tier
   * wakes on Gofer conversation messages by event type wholesale, since under the two-way
   * disposition rule every one of them needs the agent to close it out).
   * gofer_question: always true; gofer_message: heuristic — the body (before contract
   * injection) contains a question mark. During profile building, a Gofer's follow-up
   * questions arrive as gofer_message rather than gofer_question — an earlier watchdog that
   * only recognized question events left those follow-ups in a blind spot and conversations
   * stalled (observed in production). The heuristic is crude but deterministic and purely
   * local; it only affects the scope of the "reply owed" ledger's reminders, not waking.
   */
  expectsReply: boolean;
  /** Body excerpt (before contract injection), used by the pending-reply ledger and reminder notes; populated only for Gofer conversation events */
  excerpt?: string;
  /** Attachment metadata that arrived with the event; absent when the event has no attachments */
  media?: InboundMediaRef[];
}

/**
 * Host wording slots for the per-message contract. Hosts differ in their "idle turn"
 * conventions (some have a dedicated sentinel-word protocol), so the contract's sentinel
 * prohibition must be phrased by the adapter; a neutral default is used otherwise.
 */
export interface OanInboundContractOptions {
  /**
   * The "idle exit" phrase fragment, embedded into "Do not <fragment> before ...".
   * A host may inject e.g. 'end the turn with its idle sentinels'; see the neutral default below.
   */
  idleExitPhrase?: string;
}

/** Default neutral "idle exit" fragment: names no host-specific sentinel */
export const DEFAULT_IDLE_EXIT_PHRASE = 'end the turn or report idle';

// Per-message behavioral contract (structural layer): the disposition discipline is injected
// at the moment of decision — every Gofer conversation message carries its own contract rather
// than relying on a distant system prompt (it stays effective through long sessions, context
// compaction, and truncated host prompts). The core rule is a two-way disposition: (1) reply
// to the Gofer (provenance gate — send only substance the user actually stated); or (2) bring
// it to the user (ask when input is needed, brief otherwise). Three anti-mistriage guards:
// forbid the sentinel exit (don't report idle before dispatching), forbid the misclassification
// ("droppable pure context" does not exist), and disambiguate "silent" (silence toward the
// network ≠ skipping the work). Real conversations have died in production on the nonexistent
// third option "just an acknowledgment / no action needed". Wording stays domain-neutral.
function goferReplyContract(idleExitPhrase: string): string {
  return (
    '[This message has exactly two dispositions — pick one now, there is no third: ' +
    '(A) reply to the Gofer via oan_reply, only with what your user has stated, their decision, or a question the task needs — no inferences or working assumptions; or ' +
    '(B) bring it to your user — if it needs their input or decision, ask them in your own words and call oan_ask_user; otherwise give them a one-line brief. ' +
    '"Just an acknowledgment / no action needed / context only" is NOT a disposition — this is NOT droppable context. ' +
    `Do not ${idleExitPhrase} before this message is dispatched. ` +
    'Silence points at the network, not your user: send the Gofer nothing while you wait — never tell it you are checking, waiting, or planning, and never announce what information you lack. Silent means no chatter to the Gofer, NOT skipping the work.]'
  );
}

function ownerInputContract(idleExitPhrase: string): string {
  return (
    '[Your Gofer needs an answer from your side. Two dispositions only, there is no third: ' +
    '(A) your user already gave you the answer — in conversation, your memory, or earlier in this thread — deliver it via oan_reply; or ' +
    '(B) put the question to your user in your own words and call oan_ask_user. ' +
    'No guesses, no working assumptions, and nothing to the Gofer while you wait — no "let me check" or "I don\'t have this" messages. ' +
    `This is NOT droppable context: do not ${idleExitPhrase} before this question is answered or escalated.]`
  );
}


export function mapEnvelopeToInboundMessage(
  envelope: OanEventEnvelope,
  options?: OanInboundContractOptions,
): InboundMessageDraft {
  const idleExitPhrase = options?.idleExitPhrase ?? DEFAULT_IDLE_EXIT_PHRASE;
  const base = {
    contactId: contactIdForEnvelope(envelope.goferId),
    decision: false,
    untrusted: envelope.source === 'counterpart_gofer' || envelope.source === 'counterpart_party',
    createdAt: envelope.createdAt,
    sourceEventId: envelope.eventId,
    eventType: String(envelope.type),
    expectsReply: false,
  };

  switch (envelope.type) {
    case 'gofer_message': {
      const content = readString(envelope.payload, 'content');
      return {
        ...base,
        kind: 'message',
        expectsReply: containsQuestion(content),
        excerpt: content?.slice(0, 200),
        text: withContract(content, goferReplyContract(idleExitPhrase)),
      };
    }
    case 'gofer_question': {
      // kind='question' is determined by event type; under receiver sovereignty the envelope carries no "must consult" flag
      const content = readString(envelope.payload, 'content');
      return {
        ...base,
        kind: 'question',
        expectsReply: true,
        excerpt: content?.slice(0, 200),
        text: withContract(content, ownerInputContract(idleExitPhrase)),
      };
    }
    case 'session_summary': {
      // Counterpart material from a paired session (photos + documents); bytes are fetched via
      // the threadId-scoped endpoint. The threadId actually lives inside the payload (the
      // server expands it as whitelisted metadata); the envelope top level is merely an
      // optional position the protocol allows — read both, since missing either place would
      // drop the whole batch of attachments.
      const media = threadAttachments(envelope.payload, envelope.threadId ?? readString(envelope.payload, 'threadId'));
      return {
        ...base,
        kind: 'notice',
        ...(media.length > 0 ? { media } : {}),
        text: withAttachmentSummary(formatSessionSummary(envelope.payload), media),
      };
    }
    case 'pair_proposed': {
      // Decision-or-not is determined once here: only proposals carrying a reply confirmation
      // target await the user's confirmation; automatic pairing (no reply) is a pure
      // notification and must never be stored or woken on as a decision
      const requiresConfirmation = envelope.reply != null;
      return {
        ...base,
        kind: 'notice',
        decision: requiresConfirmation,
        text: formatPairProposed(envelope.payload, requiresConfirmation),
      };
    }
    case 'match_request':
      return { ...base, kind: 'notice', decision: true, text: formatMatchRequest(envelope.payload) };
    case 'match_decided':
      return { ...base, kind: 'notice', text: formatMatchDecided(envelope.payload) };
    case 'relay_message': {
      // Direct-conversation messages land in their own contact thread keyed by conversationId
      // (an account-level resource; the event has no goferId — observed in production: routing
      // them to a platform pseudo-contact leaves the agent's replies with nowhere to go).
      // As with session_summary: the container id is read top-level first with a payload
      // fallback (the server currently sends it top-level; the fallback is cheap robustness)
      const conversationId = envelope.conversationId ?? readString(envelope.payload, 'conversationId');
      const media = conversationAttachments(envelope.payload, conversationId);
      return {
        ...base,
        ...(conversationId ? { contactId: contactIdForConversation(conversationId) } : {}),
        kind: 'message',
        ...(media.length > 0 ? { media } : {}),
        text: withAttachmentSummary(formatRelayMessage(envelope.payload), media),
      };
    }
    case 'system_notice':
      return { ...base, kind: 'notice', text: formatSystemNotice(envelope.payload) };
    default:
      // The frozen v1 enum is exhausted above; unknown types get a fallback rendering so
      // protocol evolution (additive new types) never drops events
      return { ...base, kind: 'notice', text: `Unrecognized OAN event type "${String(envelope.type)}".` };
  }
}

/** Append the contract after the message body (exploiting recency position); skip injection for empty bodies to avoid delivering a pure-instruction message */
function withContract(content: string | undefined, contract: string): string {
  if (!content) return '';
  return `${content}\n\n${contract}`;
}

/** expectsReply heuristic: a body containing an ASCII or full-width question mark is treated as awaiting a response (evaluated on the original text, before contract injection) */
function containsQuestion(content: string | undefined): boolean {
  return content !== undefined && /[?？]/.test(content);
}

/**
 * Attachment inventory trailer. The text layer always lists attachment names and kinds,
 * regardless of whether bytes were fetched — record-only events never download at all, and
 * even a degraded turn after a failed download must let the agent know what it missed (so it
 * can ask the counterpart again or tell the user). Wording stays domain-neutral.
 */
function withAttachmentSummary(text: string, media: InboundMediaRef[]): string {
  if (media.length === 0) return text;
  const lines = media.map((item) => `- ${item.kind}: ${attachmentDisplayName(item.name)}`);
  const block = `Attachments (${media.length}):\n${lines.join('\n')}`;
  return text ? `${text}\n\n${block}` : block;
}

/** Placeholder label for an empty name (or one that sanitizes to empty) */
const UNNAMED_ATTACHMENT = '(unnamed)';

/** Display cap for attachment names; longer names are truncated with an ellipsis so one huge filename cannot drown the message */
const ATTACHMENT_NAME_MAX_LENGTH = 120;

/**
 * Display form of an attachment name, shared by the inventory trailer and the degraded-download
 * note (the two must agree).
 *
 * Filenames are chosen by the counterpart at upload time and passed through verbatim by the
 * server, while both rendering sites produce structured text written by the connector itself,
 * outside the untrusted quote block — a single newline smuggled into a name would let the
 * counterpart's content masquerade as connector narration (a prompt-injection surface). So:
 * replace all control characters with spaces, collapse whitespace, then cap the length.
 */
export function attachmentDisplayName(name?: string): string {
  const flattened = replaceControlCharacters(name ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flattened.length === 0) return UNNAMED_ATTACHMENT;
  if (flattened.length <= ATTACHMENT_NAME_MAX_LENGTH) return flattened;
  return `${flattened.slice(0, ATTACHMENT_NAME_MAX_LENGTH)}…`;
}

/** Replace control characters with spaces code point by code point: decided by code point rather than regex literals, so no bare control characters appear in source */
function replaceControlCharacters(value: string): string {
  return [...value].map((char) => (isControlCharacter(char) ? ' ' : char)).join('');
}

// C0 (0x00-0x1F, including tab/newline/carriage return), DEL and C1 (0x7F-0x9F), plus
// Unicode LINE SEPARATOR / PARAGRAPH SEPARATOR (0x2028 / 0x2029) — anything that can cause a
// line break or misalignment
function isControlCharacter(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}

/**
 * relay_message payload.attachments (the server-sanitized OanConversationAttachment shape) →
 * attachment references. Dropped wholesale when conversationId is missing: without the
 * container id there is no way to redeem a signed URL, and keeping them only makes downstream
 * fail repeatedly.
 */
function conversationAttachments(payload: Record<string, unknown>, conversationId?: string): InboundMediaRef[] {
  if (!conversationId) return [];
  return readObjectArray(payload, 'attachments').flatMap((entry) => {
    const attachmentId = readString(entry, 'attachmentId');
    if (!attachmentId) return [];
    return [
      {
        attachmentId,
        kind: readString(entry, 'kind') === 'document' ? ('document' as const) : ('photo' as const),
        name: readString(entry, 'name'),
        mimeType: readString(entry, 'mimeType'),
        size: readNumber(entry, 'size'),
        context: 'conversation' as const,
        conversationId,
      },
    ];
  });
}

/**
 * session_summary payload.photos / payload.documents → attachment references. Both redeem via
 * the threadId-scoped endpoint (pairing implies full sharing, independent of per-message share
 * records; payload.messageId is always null, so it is not used).
 */
function threadAttachments(payload: Record<string, unknown>, threadId?: string): InboundMediaRef[] {
  if (!threadId) return [];
  return [
    ...readObjectArray(payload, 'photos').flatMap((entry) => toThreadAttachment(entry, 'photo', threadId)),
    ...readObjectArray(payload, 'documents').flatMap((entry) => toThreadAttachment(entry, 'document', threadId)),
  ];
}

function toThreadAttachment(
  entry: Record<string, unknown>,
  kind: 'photo' | 'document',
  threadId: string,
): InboundMediaRef[] {
  const attachmentId = readString(entry, 'attachmentId');
  if (!attachmentId) return [];
  return [
    {
      attachmentId,
      kind,
      name: readString(entry, 'name'),
      mimeType: readString(entry, 'mimeType'),
      size: readNumber(entry, 'size'),
      context: 'thread' as const,
      threadId,
    },
  ];
}

function formatSessionSummary(payload: Record<string, unknown>): string {
  const title = readString(payload, 'cardTitle') ?? 'Session summary';
  const summary = readString(payload, 'summary') ?? readString(payload, 'content') ?? '';
  const counterpart = readString(payload, 'opponentRoleName');
  const lines = [title, summary];
  if (counterpart) lines.push(`Counterpart: ${counterpart}`);
  return lines.filter(Boolean).join('\n');
}

// Protocol semantics: pair_proposed awaits a decision only when it carries a reply
// confirmation target (waiting for the user's confirmation); automatic pairing (no reply) is
// a pure notification and must never bait the agent into replying YES/NO (there is nowhere to
// deliver such a decision)
function formatPairProposed(payload: Record<string, unknown>, requiresConfirmation: boolean): string {
  const name = readString(payload, 'counterpartRoleName') ?? 'A counterpart';
  const platform = readString(payload, 'counterpartSourcePlatform');
  const via = platform ? ` (via ${platform})` : '';
  if (!requiresConfirmation) {
    return `${name}${via} has been paired with this Gofer and their automatic conversation has started. No action needed.`;
  }
  return `${name}${via} has been proposed as a pairing. Reply YES to accept or NO to decline.`;
}

function formatMatchRequest(payload: Record<string, unknown>): string {
  const name = readString(payload, 'counterpartRoleName') ?? 'A counterpart';
  const platform = readString(payload, 'counterpartSourcePlatform');
  const via = platform ? ` (via ${platform})` : '';
  return `${name}${via} has requested to match. Reply YES to accept or NO to decline.`;
}

function formatMatchDecided(payload: Record<string, unknown>): string {
  const status = readString(payload, 'status') ?? 'unknown';
  return `Match request ${status}.`;
}

function formatRelayMessage(payload: Record<string, unknown>): string {
  const content = readString(payload, 'content') ?? '';
  // relay_message's source is always counterpart_party (untrusted third-party content), so an
  // explicit quote label is added to keep downstream from mistaking it for a system or
  // instruction message (see the OAN protocol document, §7)
  return `Message from the matched counterpart's owner:\n> ${content}`;
}

function formatSystemNotice(payload: Record<string, unknown>): string {
  const kind = readString(payload, 'kind');
  if (kind === 'connector_outdated') return formatConnectorOutdatedNotice(payload);
  return kind ? `Platform notice: ${kind}` : 'Platform notice.';
}

/**
 * A newer connector release exists. The update command is host-specific, so the notice states
 * the facts and sends the agent to the skill's own update section rather than naming a command
 * it might get wrong for this platform.
 */
function formatConnectorOutdatedNotice(payload: Record<string, unknown>): string {
  const installed = readString(payload, 'installed');
  const latest = readString(payload, 'latest');
  const versions = installed && latest
    ? ` You are running ${installed}; the current release is ${latest}.`
    : '';
  return 'Platform notice: a newer version of this OAN connector has been published.'
    + versions
    + ' Updating is your user\'s action, not yours: tell them a new version is available and give them'
    + ' the update steps from the "Staying current" section of the openagentnetwork skill.'
    + ' Everything keeps working on the current version in the meantime.';
}

function readString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Read an "array of objects" field: non-arrays and non-object elements are discarded (payloads come from the network; no shape assumptions) */
function readObjectArray(payload: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = payload[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null);
}
