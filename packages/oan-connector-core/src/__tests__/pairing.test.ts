// Pairing pure functions: only the redeem and key-probe functions and the
// OanPairedCredentials return shape are tested here; host config shapes and merge logic
// belong to the adapter layer.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const redeemPairingCode = vi.fn();
vi.mock('@openagentnetwork/client-js', () => ({ redeemPairingCode: (...args: unknown[]) => redeemPairingCode(...args) }));

describe('redeemPairingCredentials', () => {
  beforeEach(() => {
    redeemPairingCode.mockReset();
  });

  it('redeems the code and returns the paired credentials', async () => {
    redeemPairingCode.mockResolvedValue({ apiKey: 'test-secret-value', userId: 'u1' });
    const { redeemPairingCredentials } = await import('../pairing.js');

    const credentials = await redeemPairingCredentials('https://api.example.com', ' ABCD1234 ');

    expect(redeemPairingCode).toHaveBeenCalledWith('https://api.example.com', 'ABCD1234');
    expect(credentials).toEqual({ baseUrl: 'https://api.example.com', apiKey: 'test-secret-value' });
  });

  it('rejects an empty pairing code without calling the SDK', async () => {
    const { redeemPairingCredentials } = await import('../pairing.js');
    await expect(redeemPairingCredentials('https://api.example.com', '   ')).rejects.toThrow(/pairing code/i);
    expect(redeemPairingCode).not.toHaveBeenCalled();
  });

  it('rejects an empty base URL without calling the SDK', async () => {
    const { redeemPairingCredentials } = await import('../pairing.js');
    await expect(redeemPairingCredentials('  ', 'ABCD1234')).rejects.toThrow(/base url/i);
    expect(redeemPairingCode).not.toHaveBeenCalled();
  });
});

describe('verifyApiKeyCredentials', () => {
  it('probes the key against a read-only endpoint before returning the credentials', async () => {
    const { verifyApiKeyCredentials } = await import('../pairing.js');
    const probe = vi.fn().mockResolvedValue([]);

    const credentials = await verifyApiKeyCredentials('https://api.example.com', ' test-key-9 ', probe);

    expect(probe).toHaveBeenCalledWith('https://api.example.com', { kind: 'apiKey', apiKey: 'test-key-9' });
    expect(credentials).toEqual({ baseUrl: 'https://api.example.com', apiKey: 'test-key-9' });
  });

  it('rejects when the probe fails, without producing credentials', async () => {
    const { verifyApiKeyCredentials } = await import('../pairing.js');
    const probe = vi.fn().mockRejectedValue(new Error('401 Unauthorized'));

    await expect(verifyApiKeyCredentials('https://api.example.com', 'test-key-revoked', probe)).rejects.toThrow(
      /verification.*failed/i,
    );
  });

  it('rejects an empty key without calling the probe', async () => {
    const { verifyApiKeyCredentials } = await import('../pairing.js');
    const probe = vi.fn();
    await expect(verifyApiKeyCredentials('https://api.example.com', '  ', probe)).rejects.toThrow(/api key/i);
    expect(probe).not.toHaveBeenCalled();
  });
});
