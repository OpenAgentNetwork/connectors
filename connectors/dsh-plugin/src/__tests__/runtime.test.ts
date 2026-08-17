// Runtime lifecycle: first connection, credentials/updated idempotency (no-op on identical
// values / restart on change), the oan_pair landing path's idempotent short-circuit, effect
// teardown (stop returns fast and releases the lock), and the two-instance lock preventing
// a connection.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PendingReplyTracker, type OanConnectionOptions } from '@openagentnetwork/connector-core';
import type { HostCredentialProvider } from '../host-types.js';
import { OanRuntime, type OanRuntimeConnection } from '../runtime.js';
import { oanStatePaths, type OanStatePaths } from '../state.js';

let dir: string;
let paths: OanStatePaths;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'oan-dsh-runtime-'));
  // Isomorphic to oanStatePaths, but rooted in the test temp dir (the DSH_HOME injection form)
  paths = oanStatePaths({ DSH_HOME: dir });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakeProvider(initial?: { apiKey?: string; baseUrl?: string }): HostCredentialProvider & {
  values: Map<string, string>;
} {
  const values = new Map<string, string>();
  if (initial?.apiKey) values.set('OAN_API_KEY', initial.apiKey);
  if (initial?.baseUrl) values.set('OAN_BASE_URL', initial.baseUrl);
  return {
    values,
    resolve: async (ref) => {
      const value = values.get(ref);
      return value === undefined ? undefined : { value, source: 'file' };
    },
    describe: async () => ({ configured: true, writable: true }),
    set: async (ref, value) => {
      values.set(ref, value);
    },
    unset: async (ref) => {
      values.delete(ref);
    },
  };
}

interface FakeConnection extends OanRuntimeConnection {
  apiKey: string;
}

function fakeFactory(): { factory: (options: OanConnectionOptions) => FakeConnection; created: FakeConnection[] } {
  const created: FakeConnection[] = [];
  const factory = (options: OanConnectionOptions): FakeConnection => {
    let connected = false;
    const stub = async (): Promise<never> => {
      throw new Error('not wired in this test');
    };
    const connection: FakeConnection = {
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      authMode: { kind: 'apiKey', apiKey: options.apiKey },
      pendingReplies: new PendingReplyTracker(),
      client: {
        gofers: { sendMessage: stub },
        matchRequests: { decide: stub },
        conversations: { sendMessage: stub },
        attachments: {
          uploadGoferAttachment: stub,
          uploadGoferPhoto: stub,
          uploadConversationAttachment: stub,
          getConversationAttachmentUrl: stub,
          getThreadCounterpartAttachmentUrl: stub,
        },
        events: {
          listUnresolved: async () => ({
            events: [],
            summary: { pendingQuestions: 0, goferCount: 0, decisions: 0 },
          }),
        },
      },
      connect: async () => {
        connected = true;
      },
      disconnect: () => {
        connected = false;
      },
      statusSnapshot: () => ({ connected, eventCount: 0 }),
    };
    created.push(connection);
    return connection;
  };
  return { factory, created };
}

function makeRuntime(provider: HostCredentialProvider, overrides?: Partial<ConstructorParameters<typeof OanRuntime>[0]>) {
  const { factory, created } = fakeFactory();
  const wake = {
    requestInboxWake: vi.fn(async () => 'empty' as const),
    deliverNote: vi.fn(() => true),
    markWakeConsumed: vi.fn(async () => {}),
  };
  const runtime = new OanRuntime({
    paths,
    defaultBaseUrl: 'https://default.example',
    mediaMaxBytes: 10 * 1024 * 1024,
    credentials: provider,
    wake,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    createConnection: factory,
    supervisorTuning: { baseDelayMs: 5, maxDelayMs: 10, stableAfterMs: 10 },
    ...overrides,
  });
  return { runtime, created, wake };
}

describe('OanRuntime 连接生命周期', () => {
  it('已配对启动：建立连接并请求一次收件箱补唤醒', async () => {
    const provider = fakeProvider({ apiKey: 'k1', baseUrl: 'https://oan.example' });
    const { runtime, created, wake } = makeRuntime(provider);
    await runtime.start();
    await vi.waitFor(() => expect(runtime.isConnected()).toBe(true));
    expect(created).toHaveLength(1);
    expect(created[0].baseUrl).toBe('https://oan.example');
    await vi.waitFor(() => expect(wake.requestInboxWake).toHaveBeenCalled());
    await runtime.stop();
  });

  it('未配对启动：不建连接，等待 oan_pair', async () => {
    const { runtime, created } = makeRuntime(fakeProvider());
    await runtime.start();
    expect(created).toHaveLength(0);
    expect(runtime.readCredentialsSnapshot()).toBeUndefined();
    await runtime.stop();
  });

  it('effect 拆卸：stop() 快速返回并释放实例锁', async () => {
    const provider = fakeProvider({ apiKey: 'k1' });
    const { runtime } = makeRuntime(provider);
    await runtime.start();
    await vi.waitFor(() => expect(runtime.isConnected()).toBe(true));
    const startedAt = Date.now();
    await runtime.stop();
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(runtime.isConnected()).toBe(false);
    await expect(readFile(paths.lockPath, 'utf8')).rejects.toThrow(); // the lock has been released
  });
});

describe('credentials/updated 幂等处理', () => {
  it('同值不动作：不新建连接', async () => {
    const provider = fakeProvider({ apiKey: 'k1', baseUrl: 'https://oan.example' });
    const { runtime, created } = makeRuntime(provider);
    await runtime.start();
    await vi.waitFor(() => expect(runtime.isConnected()).toBe(true));
    await runtime.handleCredentialsUpdated();
    expect(created).toHaveLength(1);
    await runtime.stop();
  });

  it('变值重启：用新凭证新建连接', async () => {
    const provider = fakeProvider({ apiKey: 'k1', baseUrl: 'https://oan.example' });
    const { runtime, created } = makeRuntime(provider);
    await runtime.start();
    await vi.waitFor(() => expect(runtime.isConnected()).toBe(true));
    provider.values.set('OAN_API_KEY', 'k2');
    await runtime.handleCredentialsUpdated();
    await vi.waitFor(() => expect(runtime.isConnected()).toBe(true));
    expect(created).toHaveLength(2);
    expect(created[1].apiKey).toBe('k2');
    await runtime.stop();
  });

  it('凭证被清空：断开且不再重连', async () => {
    const provider = fakeProvider({ apiKey: 'k1' });
    const { runtime, created } = makeRuntime(provider);
    await runtime.start();
    await vi.waitFor(() => expect(runtime.isConnected()).toBe(true));
    provider.values.delete('OAN_API_KEY');
    await runtime.handleCredentialsUpdated();
    expect(runtime.isConnected()).toBe(false);
    expect(created).toHaveLength(1);
    await runtime.stop();
  });
});

describe('applyPairedCredentials（oan_pair 落地）', () => {
  it('幂等短路：同凭证且已连接 → already-connected，不重启', async () => {
    const provider = fakeProvider({ apiKey: 'k1', baseUrl: 'https://oan.example' });
    const { runtime, created } = makeRuntime(provider);
    await runtime.start();
    await vi.waitFor(() => expect(runtime.isConnected()).toBe(true));
    const outcome = await runtime.applyPairedCredentials({ baseUrl: 'https://oan.example', apiKey: 'k1' });
    expect(outcome).toEqual({ kind: 'already-connected' });
    expect(created).toHaveLength(1);
    await runtime.stop();
  });

  it('新凭证：写入 credentials store、当场起连接、报告 connected', async () => {
    const provider = fakeProvider();
    const { runtime, created } = makeRuntime(provider);
    await runtime.start();
    const outcome = await runtime.applyPairedCredentials({ baseUrl: 'https://oan.example', apiKey: 'k9' });
    expect(outcome).toEqual({ kind: 'connected' });
    expect(provider.values.get('OAN_API_KEY')).toBe('k9');
    expect(provider.values.get('OAN_BASE_URL')).toBe('https://oan.example');
    expect(created).toHaveLength(1);
    expect(created[0].apiKey).toBe('k9');
    await runtime.stop();
  });
});

describe('单机双实例锁', () => {
  it('活锁被占：不起连接，oan_status 增强行报告持有者 pid', async () => {
    await mkdir(path.dirname(paths.lockPath), { recursive: true });
    await writeFile(paths.lockPath, JSON.stringify({ pid: 4242, touchedAt: new Date().toISOString() }));

    const provider = fakeProvider({ apiKey: 'k1' });
    const { runtime, created } = makeRuntime(provider, { pid: 100, isPidAlive: () => true });
    await runtime.start();
    expect(created).toHaveLength(0);
    expect(runtime.statusExtras().join('\n')).toContain('pid 4242');
    await runtime.stop();
    // someone else's lock is not released by this instance
    await expect(readFile(paths.lockPath, 'utf8')).resolves.toContain('4242');
  });
});
