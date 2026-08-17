// First-time pairing flow: credentials are handed to the host through the neutral writeCredentials binding
import { beforeEach, describe, expect, it, vi } from 'vitest';

const redeemPairingCode = vi.fn();
vi.mock('@openagentnetwork/client-js', () => ({ redeemPairingCode: (...args: unknown[]) => redeemPairingCode(...args) }));

describe('runPairingSetup', () => {
  beforeEach(() => {
    redeemPairingCode.mockReset();
  });

  it('redeems the entered pairing code and hands the credentials to the host', async () => {
    redeemPairingCode.mockResolvedValue({ apiKey: 'test-secret-value', userId: 'u1' });
    const { runPairingSetup } = await import('../setup-flow.js');

    const writeCredentials = vi.fn();
    const logInfo = vi.fn();
    const logWarn = vi.fn();

    await runPairingSetup({
      promptText: async (question) => (question.includes('base URL') ? 'https://api.example.com' : 'ABCD1234'),
      writeCredentials,
      logInfo,
      logWarn,
    });

    expect(redeemPairingCode).toHaveBeenCalledWith('https://api.example.com', 'ABCD1234');
    expect(writeCredentials).toHaveBeenCalledWith({ baseUrl: 'https://api.example.com', apiKey: 'test-secret-value' });
    expect(logInfo).toHaveBeenCalled();
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('falls back to the default base URL when the operator leaves it blank', async () => {
    redeemPairingCode.mockResolvedValue({ apiKey: 'test-secret-value', userId: 'u1' });
    const { runPairingSetup, DEFAULT_BASE_URL } = await import('../setup-flow.js');

    const writeCredentials = vi.fn();
    await runPairingSetup({
      promptText: async (question) => (question.includes('base URL') ? undefined : 'ABCD1234'),
      writeCredentials,
      logInfo: vi.fn(),
      logWarn: vi.fn(),
    });

    expect(redeemPairingCode).toHaveBeenCalledWith(DEFAULT_BASE_URL, 'ABCD1234');
    expect(writeCredentials).toHaveBeenCalledWith({ baseUrl: DEFAULT_BASE_URL, apiKey: 'test-secret-value' });
  });

  it('leaves the connector unconfigured when no pairing code is entered', async () => {
    const { runPairingSetup } = await import('../setup-flow.js');

    const writeCredentials = vi.fn();
    const logWarn = vi.fn();
    await runPairingSetup({
      promptText: async () => undefined,
      writeCredentials,
      logInfo: vi.fn(),
      logWarn,
    });

    expect(redeemPairingCode).not.toHaveBeenCalled();
    expect(writeCredentials).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalled();
  });
});
