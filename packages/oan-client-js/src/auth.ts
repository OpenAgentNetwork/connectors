// OAN account authentication + connector pairing module (the protocol document's five auth
// endpoints). Except for createPairingCode, none of these require existing credentials (logging
// in is precisely how credentials are obtained), so everything here is exported as standalone
// functions rather than hung off an OanClient instance that would demand an apiKey/token first;
// OanClient provides a convenience binding only for createPairingCode.
import { OAN_REST_PATHS, type OanConnectorPlatform } from '@openagentnetwork/protocol';
import { oanRequest } from './rest-client.js';

/** The platform identifier definition lives in protocol (it is part of the wire format); re-exported here to keep the existing import name working */
export type { OanConnectorPlatform };

/**
 * OAN account object: loosely defined — what the protocol freezes is the `{ user, token }`
 * envelope shape itself, not a field-by-field contract for user's internals, so only the known
 * common fields are declared and everything else passes through as-is.
 */
export interface OanUser {
  id: string;
  email?: string;
  sourcePlatform?: string;
  [key: string]: unknown;
}

export interface OanLoginResult {
  user: OanUser;
  token: string;
}

// Google OAuth login (login and signup combined)
export async function googleLogin(
  baseUrl: string,
  input: { idToken: string; platform?: OanConnectorPlatform },
): Promise<OanLoginResult> {
  return oanRequest<OanLoginResult>(baseUrl, OAN_REST_PATHS.auth.googleLogin, {
    method: 'POST',
    body: input,
  });
}

// Sends an email verification code: the dev/test account bypass is recognized server-side via a fixed code; the SDK does not need to be aware of it
export async function requestEmailCode(baseUrl: string, email: string): Promise<void> {
  await oanRequest<{ success: boolean }>(baseUrl, OAN_REST_PATHS.auth.emailRequestCode, {
    method: 'POST',
    body: { email },
  });
}

// Verifies an email code; login and signup combined
export async function verifyEmail(
  baseUrl: string,
  input: { email: string; code: string; platform?: OanConnectorPlatform },
): Promise<OanLoginResult> {
  return oanRequest<OanLoginResult>(baseUrl, OAN_REST_PATHS.auth.emailVerify, {
    method: 'POST',
    body: input,
  });
}

// Creates a pairing code: requires a plain realm='oan' JWT (the server explicitly rejects API keys); valid for 10 minutes, single-use
export async function createPairingCode(baseUrl: string, token: string): Promise<{ code: string; expiresAt: string }> {
  return oanRequest(baseUrl, OAN_REST_PATHS.auth.pairingCodes, {
    method: 'POST',
    auth: { kind: 'jwt', token },
  });
}

// Redeems a pairing code: yields a gofers_-prefixed connector API key (one-time plaintext; the SDK never writes it to disk — the caller must persist it immediately)
export async function redeemPairingCode(baseUrl: string, code: string): Promise<{ apiKey: string; userId: string }> {
  return oanRequest(baseUrl, OAN_REST_PATHS.auth.pairingCodesRedeem, {
    method: 'POST',
    body: { code },
  });
}
