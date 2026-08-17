// Pending-reply ledger (structural layer, hardened after a real-world incident review): the
// conversational-flow state "which Gofer thread is still owed a reply" is promoted from model
// context to durable connector state. The connector mediates all inbound and outbound traffic,
// so the bookkeeping involves zero guessing:
//   open   = an expectsReply message is delivered to the agent (a crashed turn loses nothing —
//            opening precedes turn execution)
//   close  = sendOanText succeeds for that contact (the shared choke point of both entry
//            paths: thread-turn replies and cross-session messages)
//   remind = the reconnect note lists what is owed + an overdue sweep (5/30-minute tiers, at
//            most two reminders per entry — no nagging)
// Ledger failures never affect the channel itself: every persistence failure is absorbed
// silently; missing one reminder is the acceptable cost.
// The reminder note's "how to end an idle turn" host wording is an injected slot with a
// neutral default.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface PendingExchangeEntry {
  contactId: string;
  sourceEventId: string;
  /** Question excerpt (body truncated before contract injection), used in reminder notes */
  excerpt: string;
  /** When the entry was opened (ISO) */
  since: string;
  /** Overdue reminders already sent (capped at 2) */
  reminders: number;
  /** When the question was escalated to the user via oan_ask_user (ISO); affects the reminder wording branch */
  escalatedAt?: string;
}

const FIRST_REMINDER_AFTER_MS = 5 * 60_000;
const SECOND_REMINDER_AFTER_MS = 30 * 60_000;

export class PendingExchangeLedger {
  private entries = new Map<string, PendingExchangeEntry>();

  constructor(private readonly filePath: string) {}

  /** Restore the ledger at startup; a missing or corrupt file always starts empty */
  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as PendingExchangeEntry[];
      if (Array.isArray(parsed)) {
        this.entries = new Map(
          parsed
            .filter((e) => e && typeof e.contactId === 'string' && typeof e.since === 'string')
            .map((e) => [e.contactId, { ...e, reminders: typeof e.reminders === 'number' ? e.reminders : 0 }]),
        );
      }
    } catch {
      this.entries = new Map();
    }
  }

  /** Open an entry; only the latest per contact is kept (a new question replaces the old one, matching the server's one-question-at-a-time semantics) */
  async open(contactId: string, sourceEventId: string, excerpt: string, now: Date = new Date()): Promise<void> {
    this.entries.set(contactId, {
      contactId,
      sourceEventId,
      excerpt: excerpt.slice(0, 200),
      since: now.toISOString(),
      reminders: 0,
    });
    await this.persist();
  }

  /** Close: any single successful outbound message to the contact settles the entry */
  async close(contactId: string): Promise<boolean> {
    const existed = this.entries.delete(contactId);
    if (existed) await this.persist();
    return existed;
  }

  list(): PendingExchangeEntry[] {
    return [...this.entries.values()];
  }

  async recordReminder(contactId: string): Promise<void> {
    const entry = this.entries.get(contactId);
    if (!entry) return;
    entry.reminders += 1;
    await this.persist();
  }

  /** Mark the entry as escalated to the user (on a successful oan_ask_user call); it stays open until the answer is actually delivered and the entry closes */
  async markEscalated(contactId: string, now: Date = new Date()): Promise<void> {
    const entry = this.entries.get(contactId);
    if (!entry) return;
    entry.escalatedAt = now.toISOString();
    await this.persist();
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(this.list(), null, 2), 'utf8');
    } catch {
      // Persistence failures never bubble up: the ledger degrades to in-memory state and the channel carries on
    }
  }
}

/** Host wording slot for reminder notes: hosts differ in their "how to end an idle turn" conventions (sentinel words, etc.), so the adapter injects its own */
export interface PendingReminderNoteOptions {
  /**
   * The full instruction sentence for ending the turn when "the user was already asked and the
   * answer is still pending"; neutral by default. A host may inject a description of its own
   * idle-turn sentinel protocol here.
   */
  idleExitInstruction?: string;
}

/** Default neutral closing instruction: names no host-specific sentinel */
export const DEFAULT_REMINDER_IDLE_EXIT_INSTRUCTION =
  'If you already asked and are still waiting: there is nothing further to send — end the turn idle per this host\'s convention, and send the Gofer nothing while you wait.';

/**
 * Overdue reminder sweep (called on a timer by the adapter): open for over 5 minutes without
 * closing → first reminder; over 30 minutes → second (and final) reminder. Reminder notes
 * share the adapter's single notification outlet with watchdog/reconnect notes.
 */
export async function sweepPendingReminders(
  ledger: PendingExchangeLedger,
  notify: (note: string) => Promise<'queued' | 'duplicate' | 'failed'> | ('queued' | 'duplicate' | 'failed'),
  nowMs: number,
  options?: PendingReminderNoteOptions,
): Promise<void> {
  // Aggregate into a single note: N contacts falling due at once must not become N separate
  // blasts (the inbox architecture's noise discipline — the reminder's purpose is "get the
  // agent to act", and one list is enough)
  const due: PendingExchangeEntry[] = [];
  for (const entry of ledger.list()) {
    const age = nowMs - Date.parse(entry.since);
    const isDue =
      (entry.reminders === 0 && age > FIRST_REMINDER_AFTER_MS) ||
      (entry.reminders === 1 && age > SECOND_REMINDER_AFTER_MS);
    if (isDue) due.push(entry);
  }
  if (due.length === 0) return;
  // Only a genuinely enqueued note consumes a reminder tier: failed (host unavailable) does
  // not count as reminded, and neither does duplicate (the same reminder is already queued
  // and unconsumed) — a redundant enqueue is absorbed by the host and must not burn one of
  // the two tiers for nothing
  if ((await notify(buildPendingReminderNote(due, options))) === 'queued') {
    for (const entry of due) {
      await ledger.recordReminder(entry.contactId);
    }
  }
}

/** Reminder note copy (aggregated): lists each owed reply and its escalation status, and names the sole delivery route (oan_reply) */
export function buildPendingReminderNote(
  entries: PendingExchangeEntry[],
  options?: PendingReminderNoteOptions,
): string {
  const lines = entries.map((entry) =>
    entry.escalatedAt
      ? `- ${entry.contactId} (waiting since ${entry.since}, already relayed to your user at ${entry.escalatedAt}): "${entry.excerpt}"`
      : `- ${entry.contactId} (waiting since ${entry.since}, not yet relayed to your user): "${entry.excerpt}"`,
  );
  const idleExitInstruction = options?.idleExitInstruction ?? DEFAULT_REMINDER_IDLE_EXIT_INSTRUCTION;
  return (
    `Reminder — replies still owed to your user's Gofers:
${lines.join('\n')}
` +
    `For each: if your user already answered, deliver it now with the oan_reply tool (never the generic ` +
    `message tool, curl, or raw API calls); if your user's stated facts cover the question, answer it yourself ` +
    `the same way; otherwise relay the question to your user in your own words now. ${idleExitInstruction}`
  );
}
