import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { confirmPairing } from '../thread-pair-confirm.js';

describe('confirmPairing', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('POSTs to basePath + /threads/:id/pair/confirm with a Bearer apiKey header', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, text: async () => '' });

    await confirmPairing('https://api.example.com', { kind: 'apiKey', apiKey: 'test-api-key' }, 'thread-1', {
      roleId: 'g1',
      accepted: true,
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toBe('https://api.example.com/api/v1/threads/thread-1/pair/confirm');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer test-api-key' });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ roleId: 'g1', accepted: true });
  });

  it('uses a Bearer JWT header when authenticated with a token', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, text: async () => '' });

    await confirmPairing('https://api.example.com', { kind: 'jwt', token: 'jwt-token' }, 'thread-1', {
      roleId: 'g1',
      accepted: false,
    });

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer jwt-token' });
  });

  it('throws OanApiError on a non-2xx response (统一错误契约，不再抛裸 Error)', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => '{"error":"forbidden"}',
    });

    await expect(
      confirmPairing('https://api.example.com', { kind: 'apiKey', apiKey: 'test-api-key' }, 'thread-1', {
        roleId: 'g1',
        accepted: true,
      }),
    ).rejects.toMatchObject({ name: 'OanApiError', status: 403, message: 'forbidden' });
  });
});
