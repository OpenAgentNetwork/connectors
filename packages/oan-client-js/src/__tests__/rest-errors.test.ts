import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OanClient } from '../client.js';
import { createGofer } from '../gofers.js';
import { revokeApiKey } from '../api-keys.js';
import { OanApiError } from '../errors.js';
import { startFakeOanServer, type FakeOanServer } from './helpers/fake-oan-server.js';

// REST error mapping: server { error, code } response bodies must uniformly condense into an
// OanApiError carrying status/code, covering both call paths — standalone functions (no
// instance) and the OanClient-bound namespaces.
describe('REST 错误映射为 OanApiError', () => {
  const expectedToken = 'gofers_valid-token';
  let server: FakeOanServer;

  beforeEach(async () => {
    server = await startFakeOanServer({ expectedToken });
  });

  afterEach(async () => {
    await server.close();
  });

  it('凭证错误：createGofer 独立函数抛出 401 OanApiError，带 code', async () => {
    await expect(
      createGofer(server.baseUrl, { kind: 'apiKey', apiKey: 'wrong-token' }),
    ).rejects.toMatchObject({
      name: 'OanApiError',
      status: 401,
      code: 'UNAUTHORIZED',
    });
  });

  it('OanApiError 是 Error 实例且携带原始 message', async () => {
    try {
      await createGofer(server.baseUrl, { kind: 'apiKey', apiKey: 'wrong-token' });
      expect.unreachable('应抛出异常');
    } catch (error) {
      expect(error).toBeInstanceOf(OanApiError);
      expect(error).toBeInstanceOf(Error);
      expect((error as OanApiError).message).toBe('无效凭证');
    }
  });

  it('归属校验失败：revokeApiKey 抛出 403 OanApiError', async () => {
    await expect(
      revokeApiKey(server.baseUrl, { kind: 'apiKey', apiKey: expectedToken }, 'not-mine'),
    ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  it('OanClient 绑定的命名空间方法同样正确抛出/成功', async () => {
    const client = new OanClient({ baseUrl: server.baseUrl, credentials: { apiKey: expectedToken } });

    const result = await client.gofers.create();
    expect(result).toEqual({ goferId: 'g1', chatId: 'c1', greeting: '你好' });

    await expect(
      new OanClient({ baseUrl: server.baseUrl, credentials: { apiKey: 'wrong-token' } }).gofers.create(),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('auth.createPairingCode 在以 apiKey 凭证构造时应本地直接报错，不发请求', async () => {
    const client = new OanClient({ baseUrl: server.baseUrl, credentials: { apiKey: expectedToken } });
    expect(() => client.auth.createPairingCode()).toThrow(/token \(OAN JWT\)/);
  });
});
