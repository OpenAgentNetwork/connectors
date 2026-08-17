// Pure protocol logic for first-time pairing: redeem a pairing code or validate an existing
// API key, producing connection credentials. Where the credentials are stored, and in what
// shape they persist, is each host adapter's own decision.
import { listGofers, redeemPairingCode } from '@openagentnetwork/client-js';

/** Paired connection credentials: the OAN base URL + the connector API key */
export interface OanPairedCredentials {
  baseUrl: string;
  apiKey: string;
}

/** Redeem a pairing code for a connector API key. Pairing codes are single-use — credentials must be persisted immediately after a successful redemption. */
export async function redeemPairingCredentials(
  baseUrl: string,
  pairingCode: string,
): Promise<OanPairedCredentials> {
  const trimmedBaseUrl = baseUrl.trim();
  const trimmedCode = pairingCode.trim();
  if (!trimmedBaseUrl) {
    throw new Error('OAN API base URL is required.');
  }
  if (!trimmedCode) {
    throw new Error('Pairing code is required.');
  }
  const { apiKey } = await redeemPairingCode(trimmedBaseUrl, trimmedCode);
  return { baseUrl: trimmedBaseUrl, apiKey };
}

/**
 * Recovery path: complete pairing with an API key that was already redeemed.
 * Pairing codes are single-use — when the redemption succeeds but a later step fails, the code
 * is consumed while the key was never persisted, and the only way out is to configure that key
 * directly (a stranded state hit more than once in production). Before returning, the key
 * probes a read-only endpoint so a mistyped or revoked key is never handed to the adapter for
 * persistence.
 */
export async function verifyApiKeyCredentials(
  baseUrl: string,
  apiKey: string,
  probe: typeof listGofers = listGofers,
): Promise<OanPairedCredentials> {
  const trimmedBaseUrl = baseUrl.trim();
  const trimmedKey = apiKey.trim();
  if (!trimmedBaseUrl) {
    throw new Error('OAN API base URL is required.');
  }
  if (!trimmedKey) {
    throw new Error('API key is required.');
  }
  try {
    await probe(trimmedBaseUrl, { kind: 'apiKey', apiKey: trimmedKey });
  } catch (error) {
    throw new Error(
      `API key verification against ${trimmedBaseUrl} failed (${error instanceof Error ? error.message : String(error)}). ` +
        'The key may be revoked or mistyped — nothing was persisted.',
    );
  }
  return { baseUrl: trimmedBaseUrl, apiKey: trimmedKey };
}
