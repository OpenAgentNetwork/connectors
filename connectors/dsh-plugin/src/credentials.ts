// Reads and writes OAN credentials in the host credentials store: two refs (OAN_API_KEY /
// OAN_BASE_URL). Reads re-resolve every time (the harness documents that consumers
// re-resolve at each operation); writes must be preceded by a describe() writability pre-check —
// set() throws when a ref is shadowed by a launch-time environment variable (§5.2), and the
// pre-check turns that exception into an actionable error: tell the user to unset the
// variable in the shell they start dsh from, instead of surfacing a raw host exception.
import type { OanPairedCredentials } from '@openagentnetwork/connector-core';
import type { HostCredentialProvider } from './host-types.js';

export const OAN_API_KEY_REF = 'OAN_API_KEY';
export const OAN_BASE_URL_REF = 'OAN_BASE_URL';

/** Filter predicate for credentials/updated events: only changes to these two refs concern this plugin */
export function isOanCredentialRef(ref: string): boolean {
  return ref === OAN_API_KEY_REF || ref === OAN_BASE_URL_REF;
}

/**
 * Read the currently effective OAN credentials. A missing key means not paired; a missing
 * baseUrl falls back to the config default (a baseUrl on its own does not constitute pairing).
 */
export async function readOanCredentials(
  provider: HostCredentialProvider,
  defaultBaseUrl: string,
): Promise<OanPairedCredentials | undefined> {
  const apiKey = (await provider.resolve(OAN_API_KEY_REF))?.value.trim();
  if (!apiKey) return undefined;
  const baseUrl = (await provider.resolve(OAN_BASE_URL_REF))?.value.trim();
  return { apiKey, baseUrl: baseUrl || defaultBaseUrl };
}

/** Write paired credentials (pre-check writability of both refs first, then persist — never end up half-written) */
export async function writeOanCredentials(
  provider: HostCredentialProvider,
  credentials: OanPairedCredentials,
): Promise<void> {
  await assertOanCredentialsWritable(provider);
  await provider.set(OAN_API_KEY_REF, credentials.apiKey);
  await provider.set(OAN_BASE_URL_REF, credentials.baseUrl);
}

/**
 * Writability pre-check: refuse to write if any ref is shadowed by a same-named variable in
 * the launch environment (writable=false); the error text follows the host's own wording
 * style to give actionable guidance (credentials-local index.ts:410-417).
 */
export async function assertOanCredentialsWritable(provider: HostCredentialProvider): Promise<void> {
  for (const ref of [OAN_API_KEY_REF, OAN_BASE_URL_REF]) {
    const info = await provider.describe(ref);
    if (!info.writable) {
      throw new Error(
        `Cannot store OAN credentials: "${ref}" is supplied read-only by the launching environment ` +
          '(an inherited environment variable shadows the dsh credential store). Ask your user to unset ' +
          `${ref} in the shell they start dsh from, restart dsh, then retry pairing.`,
      );
    }
  }
}
