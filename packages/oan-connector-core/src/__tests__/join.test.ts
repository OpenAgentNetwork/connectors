// Email join protocol chain: requesting the verification code, the full code-to-credentials chain, no JWT leakage, and the dedicated 401 message.
import { describe, expect, it, vi } from 'vitest';
import { completeJoinWithCode, requestJoinCode, type OanJoinDeps } from '../join.js';

const TOKEN = 'operator.jwt.value';
const API_KEY = 'gofers_join_secret';

/** Stand-ins for the four client-js endpoints + call records */
function joinDeps(overrides: OanJoinDeps = {}): {
  deps: OanJoinDeps;
  calls: { verify: unknown[]; createCode: unknown[]; redeem: unknown[]; requestCode: unknown[] };
} {
  const calls = {
    verify: [] as unknown[],
    createCode: [] as unknown[],
    redeem: [] as unknown[],
    requestCode: [] as unknown[],
  };
  const deps: OanJoinDeps = {
    requestCode: async (baseUrl, email) => {
      calls.requestCode.push([baseUrl, email]);
    },
    verify: async (baseUrl, input) => {
      calls.verify.push([baseUrl, input]);
      return { user: { id: 'u1', email: input.email }, token: TOKEN };
    },
    createCode: async (baseUrl, token) => {
      calls.createCode.push([baseUrl, token]);
      return { code: 'PAIR-XYZ', expiresAt: '2026-08-15T00:10:00Z' };
    },
    redeem: async (baseUrl, code) => {
      calls.redeem.push([baseUrl, code]);
      return { apiKey: API_KEY, userId: 'u1' };
    },
    ...overrides,
  };
  return { deps, calls };
}

describe('requestJoinCode', () => {
  it('把邮箱发给 request-code 端点（前后空白裁掉）', async () => {
    const { deps, calls } = joinDeps();
    await requestJoinCode(' https://api.example ', ' user@example.com ', deps);
    expect(calls.requestCode).toEqual([['https://api.example', 'user@example.com']]);
  });

  it('邮箱缺失/格式明显不对：不发起网络调用', async () => {
    const { deps, calls } = joinDeps();
    await expect(requestJoinCode('https://api.example', '  ', deps)).rejects.toThrow(/email address is required/i);
    await expect(requestJoinCode('https://api.example', 'not-an-email', deps)).rejects.toThrow(/not a valid email/i);
    await expect(requestJoinCode('   ', 'user@example.com', deps)).rejects.toThrow(/base url/i);
    expect(calls.requestCode).toEqual([]);
  });

  it('端点失败原样上抛（调用方决定怎么解释）', async () => {
    const { deps } = joinDeps({
      requestCode: async () => {
        throw new Error('HTTP 500 /auth/oan/email/request-code');
      },
    });
    await expect(requestJoinCode('https://api.example', 'user@example.com', deps)).rejects.toThrow(/HTTP 500/);
  });
});

describe('completeJoinWithCode', () => {
  it('全链：verify → 配对码 → 兑换，只返回 baseUrl + apiKey', async () => {
    const { deps, calls } = joinDeps();
    const credentials = await completeJoinWithCode(
      'https://api.example',
      'user@example.com',
      ' 123456 ',
      'other',
      deps,
    );

    expect(calls.verify).toEqual([
      ['https://api.example', { email: 'user@example.com', code: '123456', platform: 'other' }],
    ]);
    expect(calls.createCode).toEqual([['https://api.example', TOKEN]]);
    expect(calls.redeem).toEqual([['https://api.example', 'PAIR-XYZ']]);
    expect(credentials).toEqual({ baseUrl: 'https://api.example', apiKey: API_KEY });
  });

  it('platform 缺省为 other（未声明来源时不冒认任何具体平台）', async () => {
    const { deps, calls } = joinDeps();
    await completeJoinWithCode('https://api.example', 'user@example.com', '123456', undefined, deps);
    expect((calls.verify[0] as [string, { platform?: string }])[1].platform).toBe('other');
  });

  it('JWT 绝不出现在返回值里', async () => {
    const { deps } = joinDeps();
    const credentials = await completeJoinWithCode('https://api.example', 'user@example.com', '123456', 'other', deps);
    expect(JSON.stringify(credentials)).not.toContain(TOKEN);
  });

  it('verify 返回 401：专用文案说明码已被消费、不要重试', async () => {
    const { deps, calls } = joinDeps({
      verify: async () => {
        throw Object.assign(new Error('Invalid or expired verification code'), { status: 401 });
      },
    });
    await expect(
      completeJoinWithCode('https://api.example', 'user@example.com', '123456', 'other', deps),
    ).rejects.toThrow(/already used or expired[\s\S]*do not retry with this code/);
    expect(calls.createCode).toEqual([]);
  });

  it('verify 的非 401 失败原样上抛', async () => {
    const { deps } = joinDeps({
      verify: async () => {
        throw Object.assign(new Error('HTTP 500 /auth/oan/email/verify'), { status: 500 });
      },
    });
    await expect(
      completeJoinWithCode('https://api.example', 'user@example.com', '123456', 'other', deps),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('verify 成功但没有 token：明确报错且不继续兑换', async () => {
    const { deps, calls } = joinDeps({
      verify: async () => ({ user: { id: 'u1' }, token: '' }),
    });
    await expect(
      completeJoinWithCode('https://api.example', 'user@example.com', '123456', 'other', deps),
    ).rejects.toThrow(/returned no session token/);
    expect(calls.createCode).toEqual([]);
  });

  it('兑换返回空 apiKey：明确报错', async () => {
    const { deps } = joinDeps({ redeem: async () => ({ apiKey: '', userId: 'u1' }) });
    await expect(
      completeJoinWithCode('https://api.example', 'user@example.com', '123456', 'other', deps),
    ).rejects.toThrow(/returned no API key/);
  });

  it('入参自校验先于网络调用（邮箱、验证码、基址）', async () => {
    const verify = vi.fn();
    const { deps } = joinDeps({ verify });
    await expect(completeJoinWithCode('https://api.example', 'user@example.com', ' ', 'other', deps)).rejects.toThrow(
      /verification code is required/i,
    );
    await expect(completeJoinWithCode('https://api.example', 'nope', '123456', 'other', deps)).rejects.toThrow(
      /not a valid email/i,
    );
    await expect(completeJoinWithCode('  ', 'user@example.com', '123456', 'other', deps)).rejects.toThrow(/base url/i);
    expect(verify).not.toHaveBeenCalled();
  });
});
