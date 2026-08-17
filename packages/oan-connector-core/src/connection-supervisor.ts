// Connection supervision loop (structural layer): turns "connect once, die on disconnect"
// into "disconnects are routine, self-healing is an inherent property". Rationale: every
// server release severs all WebSockets, hosting platforms cap long-lived connections, and
// resident hosts often idle — so when the client's internal reconnection attempts are
// exhausted the connection reaches a terminal state while the host still believes the channel
// is alive, and events can never arrive again. Host-level restarts may also be rationed, so
// they cannot be relied on as a recovery path. This loop reconnects indefinitely at the
// connector layer: capped exponential backoff, with the attempt counter reset after a stable
// period. The only case that never reconnects is dead credentials (reconnecting would just
// keep hitting 401; the correct exit is re-pairing). The supervising call never returns on
// its own, so it never consumes a host restart.

/** Minimal surface of the per-cycle connection object (the channel layer's factory produces an OanConnection) */
export interface SupervisedConnection {
  connect(): Promise<void>;
  disconnect(): void;
}

export type OanSupervisorTransition =
  | { kind: 'connected'; attempt: number }
  | { kind: 'reconnect-scheduled'; reason: string; attempt: number; delayMs: number }
  | { kind: 'auth-dead'; reason: string };

export interface OanSupervisorOptions {
  /**
   * Creates a fresh connection each cycle; the factory wires onCycleStopped into that
   * connection's onStopped callback — when the connection's internal reconnection is
   * exhausted or terminated, the supervision loop is notified to start the next cycle.
   */
  createConnection: (handlers: { onCycleStopped: (reason: string) => void }) => SupervisedConnection;
  abortSignal: AbortSignal;
  onTransition?: (transition: OanSupervisorTransition) => void;
  /** Injected sleep for tests; defaults to an abortable setTimeout */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Backoff parameters (tests may shorten them); defaults: start at 5s, double each time, cap at 5 minutes */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** A connection alive longer than this counts as "stable"; the attempt counter resets after it drops (so sporadic disconnects never accumulate into long backoffs) */
  stableAfterMs?: number;
  /** Clock injection (for tests) */
  now?: () => number;
}

/**
 * Stop reasons that must not reconnect (covers both client-js OanClientStopReason values and
 * descriptive text): dead credentials (reconnecting would just keep hitting 401 — the correct
 * exit is re-pairing) and account bans (an explicit server rejection). retries_exhausted is
 * deliberately absent — that is exactly the routine stop reason the supervision loop exists
 * to take over from.
 */
export function isAuthDeadReason(reason: string): boolean {
  return /unauthorized|401|api key|forbidden|banned/i.test(reason);
}

/**
 * Runs the supervision loop until aborted. Returns 'aborted' (normal shutdown) or 'auth-dead'
 * (dead-credential terminal state — the loop stops reconnecting and parks until abort; the
 * caller uses this to emit a terminal-state notification).
 */
export async function superviseOanConnection(options: OanSupervisorOptions): Promise<'aborted' | 'auth-dead'> {
  const {
    createConnection,
    abortSignal,
    onTransition,
    sleep = abortableSleep,
    baseDelayMs = 5_000,
    maxDelayMs = 5 * 60_000,
    stableAfterMs = 60_000,
    now = () => Date.now(),
  } = options;

  let attempt = 0;
  while (!abortSignal.aborted) {
    let cycleStopped!: (reason: string) => void;
    const stopped = new Promise<string>((resolve) => {
      cycleStopped = resolve;
    });
    const connection = createConnection({ onCycleStopped: (reason) => cycleStopped(String(reason)) });

    let connectedAt: number | undefined;
    let stopReason: string;
    try {
      await connection.connect();
      connectedAt = now();
      onTransition?.({ kind: 'connected', attempt });
      stopReason = await Promise.race([stopped, abortedPromise(abortSignal)]);
    } catch (error) {
      stopReason = error instanceof Error ? error.message : String(error);
    }

    connection.disconnect();
    if (abortSignal.aborted) return 'aborted';

    if (isAuthDeadReason(stopReason)) {
      onTransition?.({ kind: 'auth-dead', reason: stopReason });
      // Park until abort: the supervising call never returns on its own (returning would let
      // the host record a channel crash and burn a restart); re-pairing writes new
      // configuration, which triggers a channel-level hot restart and naturally ends this lifecycle
      await waitForAbort(abortSignal);
      return 'auth-dead';
    }

    // Stable-period reset: a connection that lived long enough proves the previous backoff worked, so this disconnect backs off from scratch as a fresh sporadic event
    if (connectedAt !== undefined && now() - connectedAt >= stableAfterMs) {
      attempt = 0;
    }
    attempt += 1;
    const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
    onTransition?.({ kind: 'reconnect-scheduled', reason: stopReason, attempt, delayMs });
    await sleep(delayMs, abortSignal);
  }
  return 'aborted';
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Race leg that settles with a sentinel string on abort: lets "wait for disconnect" also respond to shutdown */
function abortedPromise(signal: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve('aborted');
    signal.addEventListener('abort', () => resolve('aborted'), { once: true });
  });
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}
