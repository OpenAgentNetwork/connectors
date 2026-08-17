// The email join protocol chain (pure OAN semantics, host-independent): request a verification
// code → exchange the code for connector credentials. The layering rationale: both steps are
// protocol calls, so they belong in the core; how credentials are stored and how the
// connection starts are host actions and stay in the adapter.
//
// Discipline (see the OAN protocol document, openagentnetwork.ai/docs):
// - Login and registration are unified — the same verify call signs into an existing account
//   or registers a new one, so callers never need to ask the user whether they have an account;
// - The operator JWT obtained from verify lives only inside completeJoinWithCode: exchange it
//   for a one-time pairing code → immediately redeem that for a connector API key → discard
//   the JWT. The JWT is never returned to the caller and never persisted;
// - Verification codes are single-use — a successful verify consumes the code, and a repeated
//   verify returns 401, which means the earlier attempt actually succeeded.
import {
  createPairingCode,
  redeemPairingCode,
  requestEmailCode,
  verifyEmail,
  type OanConnectorPlatform,
} from '@openagentnetwork/client-js';
import type { OanPairedCredentials } from './pairing.js';

/** Injectable dependencies for the protocol chain (test stand-ins only; at runtime the real client-js implementations are the default) */
export interface OanJoinDeps {
  requestCode?: typeof requestEmailCode;
  verify?: typeof verifyEmail;
  createCode?: typeof createPairingCode;
  redeem?: typeof redeemPairingCode;
}

/** The server whitelist is openclaw|hermes|dsh|other (see the OAN protocol document, openagentnetwork.ai/docs); unspecified origins default to 'other' */
const DEFAULT_PLATFORM: OanConnectorPlatform = 'other';

/**
 * Join step one: send the 6-digit verification code to the user's email.
 * This is the only entry point — existing and new accounts take the same path
 * (login-or-register unified), so callers should never ask the user "do you have an account"
 * first.
 */
export async function requestJoinCode(baseUrl: string, email: string, deps: OanJoinDeps = {}): Promise<void> {
  const trimmedBaseUrl = requireBaseUrl(baseUrl);
  const trimmedEmail = requireEmail(email);
  await (deps.requestCode ?? requestEmailCode)(trimmedBaseUrl, trimmedEmail);
}

/**
 * Join step two: verification code → connector credentials, completed atomically
 * (verify → createPairingCode → redeem). The intermediate operator JWT lives only inside this
 * function; the return value contains nothing but baseUrl + apiKey.
 */
export async function completeJoinWithCode(
  baseUrl: string,
  email: string,
  code: string,
  platform: OanConnectorPlatform = DEFAULT_PLATFORM,
  deps: OanJoinDeps = {},
): Promise<OanPairedCredentials> {
  const trimmedBaseUrl = requireBaseUrl(baseUrl);
  const trimmedEmail = requireEmail(email);
  const trimmedCode = requireCode(code);

  const token = await verifyForOperatorToken(trimmedBaseUrl, trimmedEmail, trimmedCode, platform, deps);
  // The JWT is used solely to obtain the pairing code, then discarded (no reference survives this function)
  const { code: pairingCode } = await (deps.createCode ?? createPairingCode)(trimmedBaseUrl, token);
  const { apiKey } = await (deps.redeem ?? redeemPairingCode)(trimmedBaseUrl, pairingCode);
  if (!apiKey) {
    throw new Error(
      `The OAN server at ${trimmedBaseUrl} redeemed the pairing code but returned no API key — nothing was stored.`,
    );
  }
  return { baseUrl: trimmedBaseUrl, apiKey };
}

/** A single verify yields the operator JWT; a 401 specifically means "the code was already consumed" — a failure mode observed in production, so it gets its own actionable message */
async function verifyForOperatorToken(
  baseUrl: string,
  email: string,
  code: string,
  platform: OanConnectorPlatform,
  deps: OanJoinDeps,
): Promise<string> {
  let token: string | undefined;
  try {
    const result = await (deps.verify ?? verifyEmail)(baseUrl, { email, code, platform });
    token = result?.token;
  } catch (error) {
    if (isUnauthorized(error)) {
      throw new Error(
        'The verification code was rejected as already used or expired. A code is consumed the moment a verify ' +
          'call succeeds, so if an earlier verify attempt actually went through, do not retry with this code — ' +
          'use the credentials it already produced (check whether pairing is already in place). Otherwise ask ' +
          'your user for a freshly requested code.',
      );
    }
    throw error;
  }
  if (!token) {
    throw new Error(
      `The OAN server at ${baseUrl} accepted the verification code but returned no session token — nothing was stored.`,
    );
  }
  return token;
}

/** 401/unauthorized detection: prefer the structured HTTP status, fall back to the message text */
function isUnauthorized(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return status === 401;
  return /\b401\b|unauthorized/i.test(error instanceof Error ? error.message : String(error));
}

function requireBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl?.trim() ?? '';
  if (!trimmed) {
    throw new Error('OAN API base URL is required.');
  }
  return trimmed;
}

/** Minimal shape validation for the email: block obviously-not-an-email input before any network call */
function requireEmail(email: string): string {
  const trimmed = email?.trim() ?? '';
  if (!trimmed) {
    throw new Error('An email address is required — ask your user which email to register with.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    throw new Error(`"${trimmed}" is not a valid email address.`);
  }
  return trimmed;
}

function requireCode(code: string): string {
  const trimmed = code?.trim() ?? '';
  if (!trimmed) {
    throw new Error('The verification code is required — ask your user for the code sent to their email.');
  }
  return trimmed;
}
