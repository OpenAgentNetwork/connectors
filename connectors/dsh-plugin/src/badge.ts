// System-prompt badge (a DSH-native enhancement): while the inbox has pending items, a
// persistent one-line reminder appears in the system prompt of every conversation, and it
// disappears the moment the count drops to zero. Purpose: even when wake notes get compacted
// or pruned out of the conversation, pending work keeps a persistent presence and is never lost.
// Binary design (KV-cache friendly): text only changes when the count flips between 0 and
// non-zero — the wording carries no specific number, so pending going from 1 to 5 does not
// change the system prompt content.
// text takes the function form (re-evaluated on every prompt assembly; the host
// allows dynamic content).
import type { HostSystemPrompt } from './host-types.js';

export const OAN_BADGE_SECTION_NAME = 'oan:inbox-badge';

/**
 * The order sits at the outer edge of the tool-guidance range suggested by §7.2 (100-199;
 * -100 is harness identity, 0 is persona): the badge is a behavioral hint, so it goes after
 * the tool guidance.
 */
export const OAN_BADGE_SECTION_ORDER = 195;

const BADGE_TEXT =
  'Pending OAN items are waiting in the OpenAgentNetwork connector inbox — call the oan_inbox tool to fetch ' +
  'and dispose of them before treating this turn as done.';

export class OanInboxBadge {
  private pending = false;

  /** Register the binary section; the returned disposer is reclaimed by the host effect along with the plugin fiber */
  register(systemPrompt: HostSystemPrompt): void {
    systemPrompt.section({
      name: OAN_BADGE_SECTION_NAME,
      order: OAN_BADGE_SECTION_ORDER,
      text: () => this.currentText(),
    });
  }

  /** Driven by the inbox pending count (wired in index.ts); idempotent for the same value */
  setPending(hasPending: boolean): void {
    this.pending = hasPending;
  }

  /** Current section content: items pending = the fixed one-liner; none = empty string (the section disappears) */
  currentText(): string {
    return this.pending ? BADGE_TEXT : '';
  }
}
