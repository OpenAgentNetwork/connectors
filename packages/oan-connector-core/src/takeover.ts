// Connector-side executor for the account-takeover digest: the marker set on a cursor-less
// first connection is consumed here — fetch the server's "items still owed an answer" (raw
// event envelopes) and stage them through exactly the same mapEnvelopeToInboundMessage →
// intake pipeline as live events (eventId dedup is naturally compatible with WS redelivery and
// re-asks), then one takeover note + one wake. The agent only ever reads the local inbox; it
// never touches the digest endpoint.
import type { OanUnresolvedDigest, OanUnresolvedSummary } from '@openagentnetwork/client-js';
import {
  mapEnvelopeToInboundMessage,
  type InboundMessageDraft,
  type OanInboundContractOptions,
} from './inbound-mapping.js';
import { clearTakeoverPending, isTakeoverPending } from './takeover-store.js';

export interface TakeoverRunDeps {
  /** takeover-store file path (resolved by the adapter) */
  storePath: string;
  /** GET /events/unresolved (a binding of client-js events.listUnresolved) */
  fetchUnresolved: () => Promise<OanUnresolvedDigest>;
  /** The staging pipeline (a binding of intakeInboundDraft with requestWake unset — this executor issues the single wake itself) */
  intake: (draft: InboundMessageDraft) => Promise<void>;
  /** Takeover note delivery (a binding of the adapter's notification outlet) */
  notify: (text: string, contextKey: string) => unknown;
  /** Inbox wake (a binding of the adapter's wake mechanism) */
  wake: () => unknown;
  /** Host wording slots for the per-message contract (see inbound-mapping.ts); neutral by default */
  contract?: OanInboundContractOptions;
  log?: { info?: (msg: string) => void; warn?: (msg: string) => void };
}

/**
 * Main takeover-sweep flow. Return values:
 * skipped = the marker was not set; empty = the account owes nothing (silent);
 * seeded = owed items were staged and announced; failed = fetch/staging failed (the marker is
 * kept, and the next reconnect retries automatically — deterministic convergence).
 */
export async function runTakeoverIfPending(deps: TakeoverRunDeps): Promise<'skipped' | 'empty' | 'seeded' | 'failed'> {
  if (!(await isTakeoverPending(deps.storePath))) return 'skipped';

  let digest: OanUnresolvedDigest;
  try {
    digest = await deps.fetchUnresolved();
  } catch (error) {
    deps.log?.warn?.(`oan: takeover digest fetch failed (${String(error)}) — will retry on next reconnect.`);
    return 'failed';
  }

  try {
    for (const envelope of digest.events) {
      await deps.intake(mapEnvelopeToInboundMessage(envelope, deps.contract));
    }
    if (digest.events.length > 0) {
      deps.notify(buildTakeoverNote(digest.summary), 'oan:takeover');
      deps.wake();
    }
    await clearTakeoverPending(deps.storePath);
    deps.log?.info?.(`oan: takeover sweep ${digest.events.length > 0 ? `seeded ${digest.events.length} unresolved item(s)` : 'found nothing unresolved'}.`);
    return digest.events.length > 0 ? 'seeded' : 'empty';
  } catch (error) {
    deps.log?.warn?.(`oan: takeover staging failed (${String(error)}) — will retry on next reconnect.`);
    return 'failed';
  }
}

/**
 * The takeover note: tells the agent "this is a takeover scenario" with the counts, and
 * injects the reporting discipline — one briefing first, then strictly one question verified
 * per message. Deliberately contains the phrase "pending OAN items" to hit the skill's
 * trigger description.
 */
export function buildTakeoverNote(summary: OanUnresolvedSummary): string {
  const question = summary.pendingQuestions === 1 ? 'question' : 'questions';
  const gofer = summary.goferCount === 1 ? 'Gofer' : 'Gofers';
  const decisionPart = summary.decisions > 0
    ? ` and ${summary.decisions} pending ${summary.decisions === 1 ? 'decision' : 'decisions'}`
    : '';
  return (
    `Account takeover: this connector instance is new here, but the OAN account it joined already has ` +
    `pending OAN items — ${summary.pendingQuestions} unanswered ${question} across ${summary.goferCount} ${gofer}${decisionPart}. ` +
    `Call the oan_inbox tool to fetch them, then FIRST brief your user in one message: how many open questions, ` +
    `which Gofers they come from (use oan_gofer_history for any Gofer you lack context on), and that you will go ` +
    `through them one at a time. After the briefing, verify the items with your user strictly one per message: ` +
    `ask one, wait for their answer, deliver it via oan_reply, then raise the next. Decisions need your user's ` +
    `yes/no before any reply unless they explicitly pre-authorized you to decide.`
  );
}
