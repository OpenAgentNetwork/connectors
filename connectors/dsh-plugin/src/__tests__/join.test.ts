// The oan_join / oan_verify execution paths: argument self-validation, baseUrl resolution,
// store-and-connect, keys and JWTs staying out of result text, and the dedicated
// unreachable-server diagnosis.
import { describe, expect, it } from 'vitest';
import type { OanPairedCredentials } from '@openagentnetwork/connector-core';
import type { OanPairApplyOutcome } from '../runtime.js';
import { DSH_HOST_HINTS, runOanJoin, runOanPairing, runOanVerify, type OanPairExecutorDeps } from '../tools.js';

const KEY = 'gofers_join_secret_ABC';
const TOKEN = 'operator.jwt.value';

function joinDeps(overrides?: Partial<OanPairExecutorDeps> & { outcome?: OanPairApplyOutcome }): {
  deps: OanPairExecutorDeps;
  applied: OanPairedCredentials[];
  requested: Array<[string, string]>;
  completed: Array<[string, string, string, string | undefined]>;
} {
  const applied: OanPairedCredentials[] = [];
  const requested: Array<[string, string]> = [];
  const completed: Array<[string, string, string, string | undefined]> = [];
  const deps: OanPairExecutorDeps = {
    defaultBaseUrl: 'https://default.example',
    currentCredentials: () => undefined,
    applyPairedCredentials: async (credentials) => {
      applied.push(credentials);
      return overrides?.outcome ?? { kind: 'connected' };
    },
    requestJoin: async (baseUrl, email) => {
      requested.push([baseUrl, email]);
    },
    completeJoin: async (baseUrl: string, email: string, code: string, platform?: string) => {
      completed.push([baseUrl, email, code, platform]);
      return { baseUrl, apiKey: KEY };
    },
    ...overrides,
  };
  return { deps, applied, requested, completed };
}

/** Transport-failure stand-in: the shape undici throws on DNS failure (message=fetch failed, cause carries the code) */
function unreachable(): Error {
  return Object.assign(new Error('fetch failed'), {
    cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.openagentnetwork.ai'), { code: 'ENOTFOUND' }),
  });
}

describe('runOanJoin', () => {
  it('把邮箱交给核心协议链，并指示 agent 去要 6 位码后调 oan_verify', async () => {
    const { deps, requested } = joinDeps();
    const text = await runOanJoin(deps, { email: ' user@example.com ' });
    expect(requested).toEqual([['https://default.example', 'user@example.com']]);
    expect(text).toContain('user@example.com');
    expect(text).toContain('oan_verify');
    expect(text).toContain('Nothing is paired yet');
  });

  it('email 缺失：报错点名字段，且不发起协议调用', async () => {
    const { deps, requested } = joinDeps();
    await expect(runOanJoin(deps, {})).rejects.toThrow(/`email`/);
    await expect(runOanJoin(deps, { email: '   ' })).rejects.toThrow(/`email`/);
    expect(requested).toEqual([]);
  });

  it('baseUrl 解析：参数 > 现存凭证 > config 缺省', async () => {
    const stored = () => ({ baseUrl: 'https://stored.example', apiKey: 'k' });
    const withArg = joinDeps({ currentCredentials: stored });
    await runOanJoin(withArg.deps, { email: 'user@example.com', baseUrl: 'https://arg.example' });
    expect(withArg.requested[0][0]).toBe('https://arg.example');

    const withStored = joinDeps({ currentCredentials: stored });
    await runOanJoin(withStored.deps, { email: 'user@example.com' });
    expect(withStored.requested[0][0]).toBe('https://stored.example');

    const withDefault = joinDeps();
    await runOanJoin(withDefault.deps, { email: 'user@example.com' });
    expect(withDefault.requested[0][0]).toBe('https://default.example');
  });

  it('服务端不可达：说明是地址不通、不是凭证问题，并指出可传 baseUrl', async () => {
    const { deps } = joinDeps({
      requestJoin: async () => {
        throw unreachable();
      },
    });
    const error = await runOanJoin(deps, { email: 'user@example.com' }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toContain('unreachable');
    expect(error?.message).toContain('https://default.example');
    expect(error?.message).toContain('not a credential problem');
    expect(error?.message).toContain('baseUrl');
  });

  it('服务端有响应的失败（HTTP 状态）不伪装成不可达', async () => {
    const { deps } = joinDeps({
      requestJoin: async () => {
        throw Object.assign(new Error('Invalid email address'), { status: 400 });
      },
    });
    await expect(runOanJoin(deps, { email: 'user@example.com' })).rejects.toThrow(/Invalid email address/);
  });
});

describe('runOanVerify', () => {
  it('验证码 → 凭证 → 落地起连接，platform 声明为 dsh', async () => {
    const { deps, applied, completed } = joinDeps();
    const text = await runOanVerify(deps, { email: 'user@example.com', code: ' 123456 ' });
    expect(completed).toEqual([['https://default.example', 'user@example.com', '123456', 'dsh']]);
    expect(applied).toEqual([{ baseUrl: 'https://default.example', apiKey: KEY }]);
    expect(text).toContain('CONNECTED');
  });

  it('结果文本不含 API Key，也不含 JWT', async () => {
    const { deps } = joinDeps({
      completeJoin: async (baseUrl: string) => ({ baseUrl, apiKey: KEY }),
    });
    const text = await runOanVerify(deps, { email: 'user@example.com', code: '123456' });
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(TOKEN);
  });

  it('email / code 缺失：报错点名字段，且不发起协议调用', async () => {
    const { deps, completed } = joinDeps();
    await expect(runOanVerify(deps, { code: '123456' })).rejects.toThrow(/`email`/);
    await expect(runOanVerify(deps, { email: 'user@example.com' })).rejects.toThrow(/`code`/);
    expect(completed).toEqual([]);
  });

  it('baseUrl 解析：参数 > 现存凭证 > config 缺省', async () => {
    const withArg = joinDeps({ currentCredentials: () => ({ baseUrl: 'https://stored.example', apiKey: 'k' }) });
    await runOanVerify(withArg.deps, { email: 'u@e.com', code: '1', baseUrl: 'https://arg.example' });
    expect(withArg.completed[0][0]).toBe('https://arg.example');

    const withStored = joinDeps({ currentCredentials: () => ({ baseUrl: 'https://stored.example', apiKey: 'k' }) });
    await runOanVerify(withStored.deps, { email: 'u@e.com', code: '1' });
    expect(withStored.completed[0][0]).toBe('https://stored.example');
  });

  it('首连失败：如实报原因，并把恢复入口指向 oan_join', async () => {
    const { deps } = joinDeps({ outcome: { kind: 'failed', reason: 'socket hang up' } });
    const text = await runOanVerify(deps, { email: 'u@e.com', code: '123456' });
    expect(text).toContain('socket hang up');
    expect(text).toContain('oan_join');
  });

  it('验证码已被消费（核心 401 文案）原样透出，不被不可达诊断吞掉', async () => {
    const { deps } = joinDeps({
      completeJoin: async () => {
        throw new Error('The verification code was rejected as already used or expired.');
      },
    });
    await expect(runOanVerify(deps, { email: 'u@e.com', code: '123456' })).rejects.toThrow(/already used or expired/);
  });

  it('服务端不可达：专用诊断文案', async () => {
    const { deps } = joinDeps({
      completeJoin: async () => {
        throw unreachable();
      },
    });
    await expect(runOanVerify(deps, { email: 'u@e.com', code: '123456' })).rejects.toThrow(
      /unreachable[\s\S]*not a credential problem/,
    );
  });
});

describe('oan_pair 的不可达诊断（同一纪律）', () => {
  it('redeem 遭遇 DNS 失败时报地址不通而非配对码问题', async () => {
    const { deps } = joinDeps({
      redeem: async () => {
        throw unreachable();
      },
    });
    await expect(runOanPairing(deps, { code: 'PAIR1' })).rejects.toThrow(/unreachable/);
  });
});

describe('DSH_HOST_HINTS.howToPair（skill 与未配对错误文案共用）', () => {
  const hint = DSH_HOST_HINTS.howToPair;

  it('标准流程为主路：先要邮箱调 oan_join，再要 6 位码调 oan_verify', () => {
    expect(hint).toContain('oan_join');
    expect(hint).toContain('oan_verify');
    expect(hint.indexOf('oan_join')).toBeLessThan(hint.indexOf('oan_verify'));
    expect(hint).toContain('6-digit code');
  });

  it('明确堵死两个真机坑：不问有没有账户、不向用户索取配对码', () => {
    expect(hint).toContain('do not ask which they have');
    expect(hint).toContain('Never ask your user for a pairing code');
  });

  it('配对码只作为备选一句话出现在末尾', () => {
    expect(hint).toContain('oan_pair');
    expect(hint.indexOf('oan_pair')).toBeGreaterThan(hint.indexOf('oan_verify'));
  });
});
