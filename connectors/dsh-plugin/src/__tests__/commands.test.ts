// The /oan fallback command: input-line parsing and the handler's reuse of the oan_pair execution path.
import { describe, expect, it } from 'vitest';
import { oanCommandDefinition, parseOanCommandInput } from '../commands.js';
import type { OanPairExecutorDeps } from '../tools.js';

describe('parseOanCommandInput', () => {
  it('pair --code X --base-url Y', () => {
    expect(parseOanCommandInput(' pair --code ABC --base-url https://x.example ')).toEqual({
      kind: 'pair',
      args: { code: 'ABC', baseUrl: 'https://x.example' },
    });
  });

  it('pair --api-key-file P', () => {
    expect(parseOanCommandInput('pair --api-key-file /tmp/key.txt')).toEqual({
      kind: 'pair',
      args: { apiKeyFile: '/tmp/key.txt' },
    });
  });

  it('未知子命令 / 缺参 / 未知 flag → error', () => {
    expect(parseOanCommandInput('status').kind).toBe('error');
    expect(parseOanCommandInput('pair').kind).toBe('error');
    expect(parseOanCommandInput('pair --code').kind).toBe('error');
    expect(parseOanCommandInput('pair --bogus x').kind).toBe('error');
  });
});

describe('oanCommandDefinition', () => {
  const deps: OanPairExecutorDeps = {
    defaultBaseUrl: 'https://default.example',
    currentCredentials: () => undefined,
    applyPairedCredentials: async () => ({ kind: 'connected' }),
    redeem: async (baseUrl) => ({ baseUrl, apiKey: 'k' }),
  };

  it('recordInput=false（配对码不落 command/run 事件）', () => {
    expect(oanCommandDefinition(deps).recordInput).toBe(false);
  });

  it('handler 走 oan_pair 同一执行路径并返回成功文本', async () => {
    const definition = oanCommandDefinition(deps);
    const result = await definition.handler({
      agent: {} as never,
      rawInput: ' pair --code ABC',
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ kind: 'success' });
    expect((result as { text?: string }).text).toContain('CONNECTED');
  });

  it('执行失败转为 error 结果而非抛出', async () => {
    const definition = oanCommandDefinition({
      ...deps,
      redeem: async () => {
        throw new Error('bad pairing code');
      },
    });
    const result = await definition.handler({
      agent: {} as never,
      rawInput: 'pair --code NOPE',
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ kind: 'error', text: 'bad pairing code' });
  });
});
