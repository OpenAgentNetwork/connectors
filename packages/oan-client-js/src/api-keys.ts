// OAN connector API key management module (the protocol document's api-keys endpoints): list + revoke.
// Connector keys are issued exclusively through pairing-code redemption; this module provides no creation capability.
import { OAN_REST_PATHS } from '@openagentnetwork/protocol';
import { oanRequest, type AuthMode } from './rest-client.js';

// Metadata only; never contains key material or hashes
export interface OanApiKeyMeta {
  id: string;
  name: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

// Lists this account's API key metadata
export async function listApiKeys(baseUrl: string, auth: AuthMode): Promise<OanApiKeyMeta[]> {
  return oanRequest<OanApiKeyMeta[]>(baseUrl, OAN_REST_PATHS.apiKeys.list, {
    method: 'GET',
    auth,
  });
}

// Revokes one API key: "not found" and "not owned by this account" are both 403, with no
// existence probing; the server makes a best effort to hard-drop /oan WebSocket sessions
// established with that key (a side action — 204 alone means the key was deleted)
export async function revokeApiKey(baseUrl: string, auth: AuthMode, apiKeyId: string): Promise<void> {
  await oanRequest<void>(baseUrl, OAN_REST_PATHS.apiKeys.revoke(apiKeyId), {
    method: 'DELETE',
    auth,
  });
}
