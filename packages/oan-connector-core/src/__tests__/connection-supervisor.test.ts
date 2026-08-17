import { describe, expect, it, vi } from 'vitest';
import {
  isAuthDeadReason,
  superviseOanConnection,
  type OanSupervisorTransition,
  type SupervisedConnection,
} from '../connection-supervisor.js';

// Connection supervision loop: disconnects are routine and self-healing is inherent; only dead credentials / bans reach a terminal state
describe('superviseOanConnection', () => {
  const instantSleep = async () => undefined;

  function harness() {
    const transitions: OanSupervisorTransition[] = [];
    const controller = new AbortController();
    return {
      transitions,
      controller,
      onTransition: (t: OanSupervisorTransition) => transitions.push(t),
    };
  }

  it('连接失败无限重连（每周期新建实例），成功后如常通报', async () => {
    const { transitions, controller, onTransition } = harness();
    let attempts = 0;
    const created: SupervisedConnection[] = [];
    const result = superviseOanConnection({
      createConnection: () => {
        attempts += 1;
        const conn: SupervisedConnection = {
          connect: async () => {
            if (attempts <= 3) throw new Error(`dial failed #${attempts}`);
            // Abort right after the 4th success to end the test
            setTimeout(() => controller.abort(), 0);
          },
          disconnect: vi.fn(),
        };
        created.push(conn);
        return conn;
      },
      abortSignal: controller.signal,
      onTransition,
      sleep: instantSleep,
    });
    expect(await result).toBe('aborted');
    // Three failed reschedules + one success: the loop would keep going far past any client-side retry cap (only the mechanism's existence is verified here)
    expect(created).toHaveLength(4);
    expect(transitions.filter((t) => t.kind === 'reconnect-scheduled')).toHaveLength(3);
    expect(transitions.some((t) => t.kind === 'connected')).toBe(true);
  });

  it('连接内部终止（retries_exhausted）开启新周期，退避封顶且稳定期后计数重置', async () => {
    const { transitions, controller, onTransition } = harness();
    let cycle = 0;
    let clock = 0;
    const result = superviseOanConnection({
      createConnection: ({ onCycleStopped }) => {
        cycle += 1;
        const thisCycle = cycle;
        return {
          connect: async () => {
            if (thisCycle === 1) {
              // First cycle: connect successfully, stay alive long (> stableAfterMs), then terminate
              setTimeout(() => {
                clock += 120_000;
                onCycleStopped('retries_exhausted');
              }, 0);
            } else {
              setTimeout(() => controller.abort(), 0);
            }
          },
          disconnect: vi.fn(),
        };
      },
      abortSignal: controller.signal,
      onTransition,
      sleep: instantSleep,
      now: () => clock,
      stableAfterMs: 60_000,
    });
    expect(await result).toBe('aborted');
    const scheduled = transitions.filter(
      (t): t is Extract<OanSupervisorTransition, { kind: 'reconnect-scheduled' }> => t.kind === 'reconnect-scheduled',
    );
    expect(scheduled).toHaveLength(1);
    // A disconnect after stable uptime backs off as a first attempt (attempt reset to 0, then +1)
    expect(scheduled[0].attempt).toBe(1);
    expect(scheduled[0].reason).toBe('retries_exhausted');
  });

  it('凭据失效/账户封禁转终态：不再重连、驻留到 abort、如实通报', async () => {
    const { transitions, controller, onTransition } = harness();
    let created = 0;
    const supervising = superviseOanConnection({
      createConnection: ({ onCycleStopped }) => {
        created += 1;
        return {
          connect: async () => {
            setTimeout(() => onCycleStopped('account_banned'), 0);
          },
          disconnect: vi.fn(),
        };
      },
      abortSignal: controller.signal,
      onTransition,
      sleep: instantSleep,
    });
    // Give the terminal-state notification a microtask to fire, then abort to end the parked state
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(transitions.some((t) => t.kind === 'auth-dead')).toBe(true);
    expect(created).toBe(1);
    controller.abort();
    expect(await supervising).toBe('auth-dead');
  });

  it('abort 随时干净退出（连接中/退避睡眠中都不悬挂）', async () => {
    const controller = new AbortController();
    const supervising = superviseOanConnection({
      createConnection: () => ({
        connect: async () => {
          throw new Error('down');
        },
        disconnect: vi.fn(),
      }),
      abortSignal: controller.signal,
      // Real backoff sleep (starting at 5s), interrupted immediately by abort — verifies abortableSleep is abortable
    });
    setTimeout(() => controller.abort(), 30);
    expect(await supervising).toBe('aborted');
  });

  it('isAuthDeadReason：凭据/封禁类命中，重连耗尽类不命中', () => {
    expect(isAuthDeadReason('account_banned')).toBe(true);
    expect(isAuthDeadReason('Unauthorized: invalid API key')).toBe(true);
    expect(isAuthDeadReason('HTTP 401')).toBe(true);
    expect(isAuthDeadReason('retries_exhausted')).toBe(false);
    expect(isAuthDeadReason('transport close')).toBe(false);
  });
});
