// Wake pipeline: backfilling existing roots, most-recently-active selection, pending-wake
// coalescing (one followup for a burst of N), skipping stale agents (reference-identity
// check), and the flush persistence barrier being invoked.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { HostAgent, HostAgentRegistry, HostSession, HostUserMessage } from '../host-types.js';
import { buildInboxWakeNote, buildPluginUserMessage, OanWakeManager, type OanWakeEventBus } from '../wake.js';

interface FakeAgent extends HostAgent {
  followups: HostUserMessage[];
  emitStatus(): void;
}

function fakeAgent(id: string): FakeAgent {
  const followups: HostUserMessage[] = [];
  const statusListeners: Array<() => void> = [];
  const agent: FakeAgent = {
    id,
    session: { id } as HostSession,
    status: 'idle',
    followups,
    emitStatus: () => {
      for (const listener of statusListeners) listener();
    },
    ctx: {
      on: (name: string, listener: () => void) => {
        if (name === 'agent/status') statusListeners.push(listener);
        return () => true;
      },
    } as HostAgent['ctx'],
    followup: (message) => {
      followups.push(message);
    },
    whenIdle: () => Promise.resolve(),
  };
  return agent;
}

interface Harness {
  manager: OanWakeManager;
  agents: Map<string, FakeAgent>;
  flush: Mock;
  emitCreated: (agent: HostAgent) => void;
  setPending: (count: number) => void;
  advance: (ms: number) => void;
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'oan-dsh-wake-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function harness(initialAgents: FakeAgent[]): Harness {
  const agents = new Map(initialAgents.map((agent) => [agent.id, agent]));
  let pending = 0;
  let clock = 1_000;
  const createdListeners: Array<(payload: { agent: HostAgent }) => void> = [];
  const registry: HostAgentRegistry = {
    get: (id) => agents.get(id),
    list: () => [...agents.values()],
    roots: () => [...agents.values()],
    withoutInitiator: (operation) => operation(),
  };
  const events: OanWakeEventBus = {
    on: (name: string, listener: never) => {
      if (name === 'agent/created') createdListeners.push(listener as (payload: { agent: HostAgent }) => void);
      return () => true;
    },
  } as OanWakeEventBus;
  const flush = vi.fn(async () => true);
  const manager = new OanWakeManager({
    agents: registry,
    sessions: { flush },
    events,
    wakeStorePath: path.join(dir, 'wake.json'),
    countPendingItems: async () => pending,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    now: () => (clock += 1),
  });
  return {
    manager,
    agents,
    flush,
    emitCreated: (agent) => {
      for (const listener of createdListeners) listener({ agent });
    },
    setPending: (count) => {
      pending = count;
    },
    advance: (ms) => {
      clock += ms;
    },
  };
}

describe('OanWakeManager', () => {
  it('回补存量 roots：start() 前已存在的 agent 也能收到唤醒', async () => {
    const a = fakeAgent('a');
    const h = harness([a]);
    h.manager.start();
    h.setPending(2);
    await expect(h.manager.requestInboxWake()).resolves.toBe('delivered');
    expect(a.followups).toHaveLength(1);
    expect(a.followups[0].content[0].text).toContain('2 pending OAN items');
  });

  it('最近活跃选择：把唤醒投给最近有动静的 root', async () => {
    const a = fakeAgent('a');
    const b = fakeAgent('b');
    const h = harness([a, b]);
    h.manager.start();
    b.emitStatus(); // b is more recently active
    h.setPending(1);
    await h.manager.requestInboxWake();
    expect(b.followups).toHaveLength(1);
    expect(a.followups).toHaveLength(0);
  });

  it('合流：突发 N 条只发一次 followup；消费后可再次唤醒', async () => {
    const a = fakeAgent('a');
    const h = harness([a]);
    h.manager.start();
    h.setPending(3);
    await expect(h.manager.requestInboxWake()).resolves.toBe('delivered');
    await expect(h.manager.requestInboxWake()).resolves.toBe('coalesced');
    await expect(h.manager.requestInboxWake()).resolves.toBe('coalesced');
    expect(a.followups).toHaveLength(1);

    await h.manager.markWakeConsumed();
    await expect(h.manager.requestInboxWake()).resolves.toBe('delivered');
    expect(a.followups).toHaveLength(2);
  });

  it('收件箱为空：不打扰（empty），不投 followup', async () => {
    const a = fakeAgent('a');
    const h = harness([a]);
    h.manager.start();
    h.setPending(0);
    await expect(h.manager.requestInboxWake()).resolves.toBe('empty');
    expect(a.followups).toHaveLength(0);
  });

  it('陈旧 agent 跳过：注册表已换代的引用绝不投递（静默吞 followup 防护）', async () => {
    const a = fakeAgent('a');
    const h = harness([a]);
    h.manager.start();
    // the registry now holds a new generation of the agent under the same id: the old reference is stale
    const a2 = fakeAgent('a');
    h.agents.set('a', a2);
    h.setPending(1);
    // after the stale reference is dropped there is no other tracked root (a2 never went through the created event) → no-target
    await expect(h.manager.requestInboxWake()).resolves.toBe('no-target');
    expect(a.followups).toHaveLength(0);
    // once a2 is tracked incrementally via agent/created, delivery resumes
    h.emitCreated(a2);
    await expect(h.manager.requestInboxWake()).resolves.toBe('delivered');
    expect(a2.followups).toHaveLength(1);
  });

  it('flush 持久屏障：followup 之后 flush(agent.session) 被调用', async () => {
    const a = fakeAgent('a');
    const h = harness([a]);
    h.manager.start();
    h.setPending(1);
    await h.manager.requestInboxWake();
    expect(h.flush).toHaveBeenCalledWith(a.session);
  });

  it('deliverNote：直投注记（接管 note / 终态通知）走同一投递括号', () => {
    const a = fakeAgent('a');
    const h = harness([a]);
    h.manager.start();
    expect(h.manager.deliverNote('takeover note', 'oan:takeover')).toBe(true);
    expect(a.followups[0].content[0].text).toBe('takeover note');
    expect(h.flush).toHaveBeenCalled();
  });

  it('无可投递 root：deliverNote 返回 false，requestInboxWake 返回 no-target', async () => {
    const h = harness([]);
    h.manager.start();
    h.setPending(1);
    expect(h.manager.deliverNote('x', 'k')).toBe(false);
    await expect(h.manager.requestInboxWake()).resolves.toBe('no-target');
  });
});

describe('消息构造', () => {
  it('自建 plugin-source UserMessage：形状对齐宿主 Message 且深冻结', () => {
    const message = buildPluginUserMessage('hello');
    expect(message.role).toBe('user');
    expect(message.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(message.source).toEqual({ kind: 'plugin', plugin: 'oan' });
    expect(typeof message.id).toBe('string');
    expect(Object.isFrozen(message)).toBe(true);
    expect(Object.isFrozen(message.content[0])).toBe(true);
    expect(Object.isFrozen(message.source)).toBe(true);
  });

  it('唤醒注记带 "pending OAN items" 触发短语与单复数', () => {
    expect(buildInboxWakeNote(1)).toContain('1 pending OAN item ');
    expect(buildInboxWakeNote(4)).toContain('4 pending OAN items');
  });
});
