// Wake pipeline: when the inbox has pending items, deliver one followup note to the single
// most recently active root agent (single-point wake, no broadcast — broadcasting would
// burn a turn in each of N open conversations, with N-1 of them finding nothing).
//
// The delivery bracket (following the guards in the harness's
// sdk/server.ts:134-141):
//   ctx.agents.get(id) === agent reference-identity check (a stale reference silently
//   swallows the followup)
//   → agent.followup(self-built UserMessage) → ctx.sessions.flush(agent.session)
//   persistence barrier.
// Coalescing: the core pending-wake-store records "an unconsumed wake is in flight", so a
// burst of N items sends only one followup; oan_inbox settles it on fetch
// (markWakeConsumed), after which new events wake again.
import { randomUUID } from 'node:crypto';
import {
  listPendingMainWakes,
  removePendingMainWake,
  stagePendingMainWake,
  OAN_MAIN_WAKE_MAX_AGE_MS,
} from '@openagentnetwork/connector-core';
import type {
  HostAgent,
  HostAgentRegistry,
  HostLogger,
  HostSessionStore,
  HostUserMessage,
} from './host-types.js';

/** The fixed entry key of the inbox wake in the wake-store: wakes are aggregated, so a single account has at most one in flight */
export const OAN_INBOX_WAKE_KEY = 'inbox';

export type OanWakeOutcome = 'delivered' | 'coalesced' | 'empty' | 'no-target' | 'failed';

/** The global event surface the wake pipeline subscribes to (plain ctx; agent/created does not replay existing agents — start() backfills first) */
export interface OanWakeEventBus {
  on(name: 'agent/created', listener: (payload: { agent: HostAgent }) => void): unknown;
  on(name: 'agent/disposed', listener: (payload: { agent: HostAgent }) => void): unknown;
}

export interface OanWakeManagerDeps {
  agents: HostAgentRegistry;
  sessions: HostSessionStore;
  /** The plugin's plain ctx (listeners are reclaimed automatically with the plugin fiber) */
  events: OanWakeEventBus;
  /** pending-wake-store file path (resolved in state.ts) */
  wakeStorePath: string;
  /** Inbox pending count (the wake precondition: an empty inbox never disturbs anyone) */
  countPendingItems: () => Promise<number>;
  log: HostLogger;
  now?: () => number;
  /** Test injection: replace the message construction */
  buildMessage?: (text: string) => HostUserMessage;
}

export class OanWakeManager {
  /** id → live root reference; delivery still requires the reference-identity check against the registry */
  private readonly roots = new Map<string, HostAgent>();
  /** id → most recent activity time (both agent/status and session/event count as activity signals) */
  private readonly lastActiveAt = new Map<string, number>();
  /** Disposers of the per-root listeners: the host reclaims them when the agent is disposed; stop() clears them once more as a double safety */
  private readonly disposers: Array<() => unknown> = [];

  constructor(private readonly deps: OanWakeManagerDeps) {}

  /**
   * Start root tracking: first backfill existing roots (agent/created does not replay
   * existing agents — the host's own schedule plugin missed exactly
   * this; the backfill pattern follows session-persistence coordinator.ts:1134-1136), then
   * attach the incremental listener; track() deduplicates idempotently, so the two paths
   * overlapping is safe.
   */
  start(): void {
    for (const agent of this.deps.agents.roots()) this.track(agent);
    this.deps.events.on('agent/created', ({ agent }) => {
      // roots() determination: only track roots (owner === undefined, index.ts:613-617)
      if (this.deps.agents.roots().includes(agent)) this.track(agent);
    });
    this.deps.events.on('agent/disposed', ({ agent }) => this.untrack(agent));
  }

  /** Remove all per-root listeners (disposers are safe to call repeatedly and do not conflict with the automatic reclamation on agent disposal) */
  stop(): void {
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // the listener may already have been reclaimed with the agent fiber
      }
    }
    this.roots.clear();
    this.lastActiveAt.clear();
  }

  /**
   * Inbox wake (the intake clerk's requestWake implementation):
   * an empty inbox never disturbs anyone; an unconsumed, unexpired in-flight wake coalesces
   * and skips; otherwise record the in-flight entry and deliver a wake note to the most
   * recently active root (the wording carries the "pending OAN items" phrase to hit the
   * skill trigger description).
   */
  async requestInboxWake(): Promise<OanWakeOutcome> {
    const pending = await this.deps.countPendingItems();
    if (pending === 0) {
      await removePendingMainWake(this.deps.wakeStorePath, OAN_INBOX_WAKE_KEY).catch(() => {});
      return 'empty';
    }
    const inFlight = (await listPendingMainWakes(this.deps.wakeStorePath).catch(() => []))
      .find((entry) => entry.contactId === OAN_INBOX_WAKE_KEY);
    const now = this.now();
    if (inFlight && now - Date.parse(inFlight.queuedAt) <= OAN_MAIN_WAKE_MAX_AGE_MS) {
      return 'coalesced'; // an unconsumed wake is already in flight: a burst of N items sends only one followup
    }

    const target = this.pickMostRecentlyActive();
    if (!target) {
      this.deps.log.warn('oan: inbox wake skipped — no live root agent to deliver to.');
      return 'no-target';
    }
    // Record in flight before delivering: on delivery failure the record is removed and the next inbound event retries
    await stagePendingMainWake(this.deps.wakeStorePath, {
      contactId: OAN_INBOX_WAKE_KEY,
      question: '',
      mainSessionKey: target.id,
    }).catch(() => {});
    if (!this.deliver(target, buildInboxWakeNote(pending))) {
      await removePendingMainWake(this.deps.wakeStorePath, OAN_INBOX_WAKE_KEY).catch(() => {});
      return 'failed';
    }
    return 'delivered';
  }

  /** Wake settlement: fetching via oan_inbox consumes the wake; later inbound events trigger a wake again */
  async markWakeConsumed(): Promise<void> {
    await removePendingMainWake(this.deps.wakeStorePath, OAN_INBOX_WAKE_KEY).catch(() => {});
  }

  /**
   * Deliver a note directly (takeover note / dead-credential terminal state / reminders),
   * sharing the same delivery bracket as the inbox wake. contextKey is only a log anchor —
   * DSH's followup has no host-level dedup queue, so repeat control belongs to the caller
   * (advisory-store / the ledger's reminder tiers).
   */
  deliverNote(text: string, contextKey: string): boolean {
    const target = this.pickMostRecentlyActive();
    if (!target) {
      this.deps.log.warn(`oan: note ${contextKey} dropped — no live root agent to deliver to.`);
      return false;
    }
    return this.deliver(target, text);
  }

  /** Pick the most recently active root: first drop stale references (registry identity check), then take the largest lastActiveAt */
  private pickMostRecentlyActive(): HostAgent | undefined {
    let best: HostAgent | undefined;
    let bestAt = -1;
    for (const [id, agent] of [...this.roots]) {
      if (this.deps.agents.get(id) !== agent) {
        this.untrack(agent);
        continue;
      }
      const at = this.lastActiveAt.get(id) ?? 0;
      if (at > bestAt) {
        best = agent;
        bestAt = at;
      }
    }
    return best;
  }

  /**
   * The delivery bracket: reference-identity check → followup (queues an independent turn
   * and wakes; queued while busy, immediate while idle) → flush persistence barrier
   * (followup only buffers after write; flush is what guarantees replay across restarts,
   * §4.3).
   */
  private deliver(agent: HostAgent, text: string): boolean {
    if (this.deps.agents.get(agent.id) !== agent) {
      this.untrack(agent);
      return false;
    }
    const message = (this.deps.buildMessage ?? buildPluginUserMessage)(text);
    try {
      agent.followup(message);
    } catch (error) {
      this.deps.log.warn(`oan: followup delivery failed for agent "${agent.id}": ${String(error)}`);
      return false;
    }
    void this.deps.sessions.flush(agent.session).catch((error: unknown) => {
      this.deps.log.warn(`oan: session flush after wake failed: ${String(error)}`);
    });
    return true;
  }

  /** Track a root: idempotent; per-root listeners attach to agent.ctx (reclaimed automatically when the agent is disposed, §4.5) */
  private track(agent: HostAgent): void {
    if (this.roots.get(agent.id) === agent) return;
    this.roots.set(agent.id, agent);
    this.lastActiveAt.set(agent.id, this.now());
    try {
      this.disposers.push(
        agent.ctx.on('agent/status', () => this.lastActiveAt.set(agent.id, this.now())),
        agent.ctx.on('session/event', () => this.lastActiveAt.set(agent.id, this.now())),
      );
    } catch (error) {
      // a listener failure only degrades the "most recently active" precision (falls back to the tracking time); delivery capability is unaffected
      this.deps.log.warn(`oan: per-root listeners failed for agent "${agent.id}": ${String(error)}`);
    }
  }

  private untrack(agent: HostAgent): void {
    if (this.roots.get(agent.id) !== agent) return;
    this.roots.delete(agent.id);
    this.lastActiveAt.delete(agent.id);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

/** The wake note: states only the fact that items are pending and how to fetch them; content belongs to oan_inbox (carries the skill trigger phrase) */
export function buildInboxWakeNote(pendingCount: number): string {
  const noun = pendingCount === 1 ? 'item' : 'items';
  return (
    `${pendingCount} pending OAN ${noun} from your user's Gofers are waiting. Call the oan_inbox tool now to ` +
    'fetch and handle them: answer from what your user actually stated via oan_reply, and relay to your user ' +
    "anything that needs their input or decision (register it with oan_ask_user). Decisions need your user's " +
    'yes/no unless they explicitly pre-authorized you to decide.'
  );
}

/**
 * Self-built plugin-source UserMessage: the host's
 * createUserMessage cannot be imported; the inbox only checks message id uniqueness
 * (inbox.ts:202-219), so a structurally identical self-built object works.
 * Deep-frozen to match the host convention (message.ts:166-169 freezeMessage=deepFreeze).
 */
export function buildPluginUserMessage(text: string): HostUserMessage {
  return deepFreeze({
    id: randomUUID(),
    role: 'user' as const,
    content: [{ type: 'text' as const, text }],
    source: { kind: 'plugin' as const, plugin: 'oan' },
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
