// Inbound intake: when a Gofer message/event arrives it triggers **no host session turn** —
// everything is written to the connector's own inbox store, and the wake pipeline notifies the
// agent so its next turn collects the items via the oan_inbox tool.
//
// Why not deliver inbound as channel session turns: host transcripts follow an
// "inbound/assistant" two-role model, so a channel inbound message inevitably lands in the
// transcript rendered on the inbound side (displayed as "You" in the console) — the Gofer's
// words look like the user's own, an unacceptable provenance confusion. In the inbox model the
// only user-visible surface is the agent's own words; the Gofer's original text exists only in
// the inbox and the network-side archive (the web conversation page).
//
// Responsibility boundary: this module is purely the "intake clerk" — persist attachments,
// stage into the inbox (deduplicated by eventId), open pending-reply ledger entries, and
// request a wake. The wake mechanism itself (how the agent is notified) belongs to the adapter.
import { markInboxItemsHandled, pruneHandledInboxItems, stageInboxItem } from './inbox-store.js';
import type { OanInboundMediaStager } from './media.js';
import type { InboundMessageDraft } from './inbound-mapping.js';

/**
 * Wake tiers. Product semantics: the host agent already knows the user's background from
 * everyday collaboration, so it answers a Gofer's follow-ups on the user's behalf, and relays
 * to the user whatever it cannot answer.
 * - all (default): every message-class inbound wakes the agent for triage (the agent closes
 *   out each message under the two-way disposition discipline);
 * - actionable: all Gofer conversation messages (questions and ordinary messages alike need
 *   disposition), decisions, and messages from the counterpart's owner wake the agent; pure
 *   platform notifications are staged as context only;
 * - none: observation only — everything is staged, nothing wakes (the next natural turn's
 *   pointer still surfaces it).
 * Note: the tier only decides whether to wake — **staging is unconditional**. The inbox
 * doubles as the agent's conversational context tail, so even acknowledgment-class messages
 * must be visible or the agent has no way to follow the conversation's progress.
 */
export type OanAutoReplyMode = 'actionable' | 'all' | 'none';

// Event types that always wake on the actionable tier: **every** message in the account's own
// Gofer conversations (gofer_message / gofer_question — under the two-way disposition
// architecture each must end in "reply to the Gofer or brief the user"; question-mark-free
// invitations and acknowledgments are dispositions too), plus direct messages from the
// counterpart's owner (relay_message). Decision types (match/pair) are deliberately absent —
// whether something awaits a decision is determined at mapping time (draft.decision); matching
// on raw types would wake on reply-less automatic pairings, which are pure notifications
const ACTIONABLE_EVENT_TYPES = new Set(['gofer_message', 'gofer_question', 'relay_message']);

/**
 * Whether this inbound item should wake the agent.
 *
 * Receiver sovereignty: the platform only delivers; the envelope carries no "must consult the
 * user" flag — answering autonomously versus briefing the user is entirely the agent's call
 * (the discipline lives in the skill), so triage never depends on server-side flags.
 * On the actionable tier, Gofer conversation messages wake wholesale by event type, no longer
 * filtered through expectsReply (the question-mark heuristic) — past incidents came precisely
 * from layered filters (type filters, the question-mark heuristic, "just an acknowledgment"
 * misclassification) swallowing question-mark-free follow-ups and invitations as "pure
 * context", permanently stalling conversations; under the two-way disposition rule every Gofer
 * message must be closed out by the agent. expectsReply is retained for the pending-reply
 * watchdog (only what awaits a reply opens a ledger entry). Decisions are judged by
 * draft.decision (determined once at mapping time; only consumed here), so reply-less
 * automatic-pairing notifications never wake.
 */
export function shouldWakeAgent(draft: InboundMessageDraft, mode: OanAutoReplyMode): boolean {
  if (mode === 'all') return true;
  if (mode === 'none') return false;
  return draft.decision || ACTIONABLE_EVENT_TYPES.has(draft.eventType);
}

export interface InboundIntakeDeps {
  /** Inbox file path (resolved by the adapter, e.g. stateDir/oan/inbox.json) */
  inboxPath: string;
  /**
   * Inbound attachment stager (see media.ts). Bytes are fetched only for items that will wake
   * the agent (acknowledgment-class events are not worth downloading); when not injected,
   * nothing is downloaded — the attachment inventory in the body still tells the agent what
   * the counterpart sent.
   */
  stageInboundMedia?: OanInboundMediaStager;
  /**
   * Pending-reply ledger (persistence layer): messages awaiting a response (expectsReply) open
   * an entry at staging time — whenever the agent eventually collects them, "this contact is
   * owed a reply" is already durably on record; settlement happens at the sendOanText choke
   * point (wired by the adapter).
   */
  pendingLedger?: { open: (contactId: string, sourceEventId: string, excerpt: string) => void };
  /**
   * Wake request (implemented by the adapter): how the agent is told "the inbox has pending
   * work" is up to the host mechanism. Should be idempotent — several consecutive inbound
   * items coalesce into one effective wake.
   */
  requestWake?: () => void;
  /** Wake tier, from adapter configuration; defaults to all */
  autoReply?: OanAutoReplyMode;
  log?: { info?: (msg: string) => void; warn?: (msg: string) => void; error?: (msg: string) => void };
}

/** How many handled items to keep as a tail: both the eventId redelivery-dedup window and oan_inbox's source of recent context */
const INBOX_HANDLED_KEEP = 80;

export async function intakeInboundDraft(deps: InboundIntakeDeps, draft: InboundMessageDraft): Promise<void> {
  const mode = deps.autoReply ?? 'all';
  const wakes = shouldWakeAgent(draft, mode);

  // Attachments persist before staging: the staged item must carry the final body (rewritten
  // with a degradation note when attachments could not be fetched) and the local paths
  let body = draft.text;
  let mediaPaths: string[] | undefined;
  const refs = draft.media ?? [];
  if (refs.length > 0 && deps.stageInboundMedia && wakes) {
    try {
      const staged = await deps.stageInboundMedia(refs, draft.text, draft.contactId);
      body = staged.text;
      const paths = staged.media
        .map((facts) => (facts as { path?: string }).path)
        .filter((p): p is string => typeof p === 'string' && p.length > 0);
      mediaPaths = paths.length > 0 ? paths : undefined;
    } catch (error) {
      deps.log?.warn?.(`oan: inbound media staging failed for ${draft.contactId}: ${String(error)}`);
    }
  }

  let staged: 'staged' | 'duplicate';
  try {
    staged = await stageInboxItem(deps.inboxPath, {
      eventId: draft.sourceEventId,
      contactId: draft.contactId,
      // Decision-or-not follows the mapping layer's creation-time judgment (draft.decision), never guessed from raw event types
      kind: draft.decision ? 'decision' : draft.kind === 'notice' ? 'event' : 'message',
      body,
      ...(mediaPaths ? { mediaPaths } : {}),
      receivedAt: draft.createdAt,
    });
  } catch (error) {
    // A staging failure is the worst failure surface: the message is in neither the session
    // nor the inbox. Log it honestly; the server redelivers while the event cursor has not
    // advanced (eventId dedup keeps redelivery safe)
    deps.log?.error?.(`oan: inbox staging failed for ${draft.contactId} (${draft.sourceEventId}): ${String(error)}`);
    return;
  }
  if (staged === 'duplicate') return; // WS redelivery: every side effect (ledger open / wake) already happened

  if (!wakes) {
    // Acknowledgments / pure notifications: staging is all they need — mark handled
    // immediately, since they are context tail, not pending work
    try {
      await markInboxItemsHandled(deps.inboxPath, [draft.sourceEventId]);
    } catch {
      // A failed mark at worst shows the item as pending in oan_inbox once; the agent's triage absorbs it naturally
    }
    void pruneHandledInboxItems(deps.inboxPath, { keep: INBOX_HANDLED_KEEP }).catch(() => {});
    return;
  }

  // Open the ledger entry before waking: a failed or delayed wake never affects the durable fact that a reply is owed
  if (draft.expectsReply) {
    try {
      deps.pendingLedger?.open(draft.contactId, draft.sourceEventId, draft.excerpt ?? '');
    } catch {
      deps.log?.warn?.(`oan: pending-ledger open failed for ${draft.contactId}.`);
    }
  }
  try {
    deps.requestWake?.();
  } catch (error) {
    // A failed wake loses no message: the item is already pending in the inbox, and any next turn's pointer or reminder surfaces it
    deps.log?.warn?.(`oan: inbox wake request failed for ${draft.contactId}: ${String(error)}`);
  }
  void pruneHandledInboxItems(deps.inboxPath, { keep: INBOX_HANDLED_KEEP }).catch(() => {});
}
