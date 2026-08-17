// The oan_pair execution path: the full code flow, apiKeyFile (plain text/JSON),
// writable=false guidance, idempotent re-pairing, and the key never appearing in result text.
import { describe, expect, it } from 'vitest';
import type { OanPairedCredentials } from '@openagentnetwork/connector-core';
import { assertOanCredentialsWritable, writeOanCredentials } from '../credentials.js';
import type { HostCredentialProvider } from '../host-types.js';
import type { OanPairApplyOutcome } from '../runtime.js';
import { extractApiKey, runOanPairing, type OanPairExecutorDeps } from '../tools.js';

const KEY = 'gofers_secret_ABC123';

function pairDeps(overrides?: Partial<OanPairExecutorDeps> & { outcome?: OanPairApplyOutcome }): {
  deps: OanPairExecutorDeps;
  applied: OanPairedCredentials[];
} {
  const applied: OanPairedCredentials[] = [];
  const deps: OanPairExecutorDeps = {
    defaultBaseUrl: 'https://default.example',
    currentCredentials: () => undefined,
    applyPairedCredentials: async (credentials) => {
      applied.push(credentials);
      return overrides?.outcome ?? { kind: 'connected' };
    },
    redeem: async (baseUrl, code) => ({ baseUrl, apiKey: `${KEY}-from-${code}` }),
    verifyKey: async (baseUrl, apiKey) => ({ baseUrl, apiKey }),
    ...overrides,
  };
  return { deps, applied };
}

describe('runOanPairing', () => {
  it('code 路径：兑换 → 落地 → 报告 CONNECTED，key 不出现在结果文本', async () => {
    const { deps, applied } = pairDeps();
    const text = await runOanPairing(deps, { code: 'PAIR1' });
    expect(applied).toEqual([{ baseUrl: 'https://default.example', apiKey: `${KEY}-from-PAIR1` }]);
    expect(text).toContain('CONNECTED');
    expect(text).not.toContain(KEY);
  });

  it('baseUrl 解析：参数 > 现存凭证 > config 缺省', async () => {
    const { deps, applied } = pairDeps({
      currentCredentials: () => ({ baseUrl: 'https://stored.example', apiKey: 'k' }),
    });
    await runOanPairing(deps, { code: 'C', baseUrl: 'https://arg.example' });
    expect(applied[0].baseUrl).toBe('https://arg.example');

    const second = pairDeps({ currentCredentials: () => ({ baseUrl: 'https://stored.example', apiKey: 'k' }) });
    await runOanPairing(second.deps, { code: 'C' });
    expect(second.applied[0].baseUrl).toBe('https://stored.example');
  });

  it('apiKeyFile 路径：纯文本文件', async () => {
    const { deps, applied } = pairDeps({ readFileText: async () => `${KEY}\n` });
    const text = await runOanPairing(deps, { apiKeyFile: '/tmp/key.txt' });
    expect(applied[0].apiKey).toBe(KEY);
    expect(text).not.toContain(KEY);
  });

  it('apiKeyFile 路径：JSON 的 apiKey 字段', async () => {
    const { deps, applied } = pairDeps({
      readFileText: async () => JSON.stringify({ apiKey: KEY, userId: 'u1' }),
    });
    await runOanPairing(deps, { apiKeyFile: '/tmp/redeem.json' });
    expect(applied[0].apiKey).toBe(KEY);
  });

  it('apiKeyFile 内容无 key：报错并指出期望格式', async () => {
    const { deps } = pairDeps({ readFileText: async () => 'some prose without a key token' });
    await expect(runOanPairing(deps, { apiKeyFile: '/tmp/empty.txt' })).rejects.toThrow(/No API key found/);
  });

  it('code 与 apiKeyFile 互斥；两者皆缺报错', async () => {
    const { deps } = pairDeps();
    await expect(runOanPairing(deps, {})).rejects.toThrow(/either/);
    await expect(runOanPairing(deps, { code: 'C', apiKeyFile: '/p' })).rejects.toThrow(/only one/);
  });

  it('幂等重配：already-connected 结果如实报告"没有重启"', async () => {
    const { deps } = pairDeps({ outcome: { kind: 'already-connected' } });
    const text = await runOanPairing(deps, { code: 'SAME' });
    expect(text).toContain('Already paired');
    expect(text).toContain('no reconnect');
  });

  it('首连失败：如实报原因并说明连接器持续重试', async () => {
    const { deps } = pairDeps({ outcome: { kind: 'failed', reason: 'network unreachable' } });
    const text = await runOanPairing(deps, { code: 'C' });
    expect(text).toContain('network unreachable');
    expect(text).toContain('retrying');
  });
});

describe('extractApiKey', () => {
  it('JSON apiKey 字段优先', () => {
    expect(extractApiKey(JSON.stringify({ apiKey: KEY }))).toBe(KEY);
  });
  it('纯文本中的 gofers_ 前缀 token', () => {
    expect(extractApiKey(`api key: ${KEY} (redeemed 2026-08-15)`)).toBe(KEY);
  });
  it('单 token 纯文本整体视为 key', () => {
    expect(extractApiKey('  plain-token-key  ')).toBe('plain-token-key');
  });
  it('多词无 gofers_ 前缀内容返回 undefined', () => {
    expect(extractApiKey('nothing to see here')).toBeUndefined();
    expect(extractApiKey('')).toBeUndefined();
  });
});

describe('凭证写入的 writable 预检', () => {
  function provider(writableByRef: Record<string, boolean>): HostCredentialProvider & { sets: string[][] } {
    const sets: string[][] = [];
    return {
      sets,
      resolve: async () => undefined,
      describe: async (ref) => ({ configured: false, writable: writableByRef[ref] ?? true }),
      set: async (ref, value) => {
        sets.push([ref, value]);
      },
      unset: async () => {},
    };
  }

  it('被启动环境遮蔽（writable=false）：抛带 unset 指引的错误，且不写任何 ref', async () => {
    const p = provider({ OAN_API_KEY: false });
    await expect(
      writeOanCredentials(p, { baseUrl: 'https://x', apiKey: 'k' }),
    ).rejects.toThrow(/unset[\s\S]*shell they start dsh from/);
    expect(p.sets).toEqual([]);
  });

  it('可写时两个 ref 都落盘', async () => {
    const p = provider({});
    await writeOanCredentials(p, { baseUrl: 'https://x', apiKey: 'k' });
    expect(p.sets).toEqual([
      ['OAN_API_KEY', 'k'],
      ['OAN_BASE_URL', 'https://x'],
    ]);
  });

  it('assertOanCredentialsWritable 逐 ref 检查', async () => {
    const p = provider({ OAN_BASE_URL: false });
    await expect(assertOanCredentialsWritable(p)).rejects.toThrow(/OAN_BASE_URL/);
  });
});
