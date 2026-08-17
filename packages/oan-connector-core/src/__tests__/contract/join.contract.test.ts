// Live contract tests (connector-core): cover only this package's own composition — join.ts's
// requestJoinCode / completeJoinWithCode end to end against a real OAN server.
//
// Responsibility boundary: individual REST endpoints' response shapes belong to the
// client library's own contract suite; this suite only verifies that the "three steps chained
// into one" composition actually runs through once on a real server, and that the
// intermediate operator JWT never leaks out of the return value.
//
// Gating: runs only when OAN_CONTRACT_BASE_URL, OAN_CONTRACT_EMAIL and OAN_CONTRACT_CODE are
// all set; a default `vitest run` skips the whole suite (exit code 0).
//
// Maintainer-only: the suite needs a non-production deployment configured to accept a test
// account whose verification code is known ahead of time, so no real mailbox is involved.
// Credentials are never committed — supply them through the environment variables above.
//
// Hygiene: this suite creates no Gofer (the join chain produces none), but afterAll still does
// a safety-net cleanup so that even a future test case that creates one leaves no litter on
// the target deployment; the apiKey is never logged and never enters assertion messages.
//
// ── Call surfaces this suite deliberately does not cover, and what covers them ─────────────
// - join.ts's failure branches (empty/invalid email, empty code, the 401 message, the server
//   returning no token): all pure local validation or requiring fabricated server errors —
//   covered by join.test.ts's injected stand-ins; hitting the network adds nothing;
// - Credential persistence, connection establishment, inbox/cursor and other host actions:
//   not this package's concern (adapter responsibilities), covered by each connector's unit
//   tests plus real-device acceptance;
// - The rest of this package (stores/mapping/router/tools/media/skill) is pure local logic
//   with no live contract surface.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteGofer, listGofers, type AuthMode } from '@openagentnetwork/client-js';
import { completeJoinWithCode, requestJoinCode } from '../../join.js';
import type { OanPairedCredentials } from '../../pairing.js';

/** Gate switch: the suite is skipped — and the network never touched — unless all three are supplied */
const CONTRACT_BASE_URL = process.env.OAN_CONTRACT_BASE_URL?.trim() ?? '';
/** Test account and its known verification code, supplied by the maintainer's environment, never committed */
const CONTRACT_EMAIL = process.env.OAN_CONTRACT_EMAIL?.trim() ?? '';
const BYPASS_CODE = process.env.OAN_CONTRACT_CODE?.trim() ?? '';
const CONTRACT_ENABLED = CONTRACT_BASE_URL.length > 0 && CONTRACT_EMAIL.length > 0 && BYPASS_CODE.length > 0;

/** Per-test timeout: real network + serverless cold starts make 10s too tight */
const CONTRACT_TIMEOUT_MS = 30_000;

if (!CONTRACT_ENABLED) {
  console.info(
    '[contract] Live contract tests skipped. Set OAN_CONTRACT_BASE_URL, OAN_CONTRACT_EMAIL and OAN_CONTRACT_CODE, then run ' +
      '`pnpm --filter @openagentnetwork/connector-core test:contract` to enable them.',
  );
}

describe.skipIf(!CONTRACT_ENABLED)('OAN 线上契约 · connector-core join 链', () => {
  /** The product of a single join chain, read-only for all test cases, to avoid creating accounts repeatedly */
  let credentials: OanPairedCredentials;
  let auth: AuthMode = { kind: 'none' };

  beforeAll(async () => {
    await assertServerReachable(CONTRACT_BASE_URL);

    await requestJoinCode(CONTRACT_BASE_URL, CONTRACT_EMAIL);
    credentials = await completeJoinWithCode(CONTRACT_BASE_URL, CONTRACT_EMAIL, BYPASS_CODE, 'other');
    auth = { kind: 'apiKey', apiKey: credentials.apiKey };
  }, CONTRACT_TIMEOUT_MS);

  afterAll(async () => {
    if (auth.kind !== 'apiKey') return;
    // Safety-net cleanup: this suite normally creates no Gofer; this guarantees no leftovers stay on the target deployment
    try {
      const gofers = await listGofers(CONTRACT_BASE_URL, auth);
      for (const gofer of gofers) {
        await deleteGofer(CONTRACT_BASE_URL, auth, gofer.goferId);
      }
    } catch {
      // Cleanup is best-effort; a transient server error must not turn the whole suite red
    }
  }, CONTRACT_TIMEOUT_MS);

  it(
    '6a. requestJoinCode 对旁路账号不抛错',
    () => {
      // Already truly called in beforeAll; reaching this point means it did not throw
      expect(credentials).toBeDefined();
    },
    CONTRACT_TIMEOUT_MS,
  );

  it(
    '6b. completeJoinWithCode 端到端拿到 { baseUrl, apiKey }',
    () => {
      expect(credentials.baseUrl).toBe(CONTRACT_BASE_URL);
      expect(typeof credentials.apiKey).toBe('string');
      expect(credentials.apiKey.startsWith('gofers_')).toBe(true);
    },
    CONTRACT_TIMEOUT_MS,
  );

  it(
    '6c. 返回值里不含 token/JWT 任何痕迹（operator JWT 只在函数内存活）',
    () => {
      // Assert the key set itself: any extra field is forced to justify itself here
      expect(Object.keys(credentials).sort()).toEqual(['apiKey', 'baseUrl']);
      const serialized = JSON.stringify(credentials);
      expect(serialized).not.toMatch(/token|jwt/i);
      // The JWT's three-part signature pattern (header.payload.signature) must not appear in any field value
      expect(serialized).not.toMatch(/eyJ[\w-]+\./);
    },
    CONTRACT_TIMEOUT_MS,
  );

  it(
    '6d. 拿到的 apiKey 真的可用（能对账户面发起一次鉴权调用）',
    async () => {
      const gofers = await listGofers(CONTRACT_BASE_URL, auth);
      expect(Array.isArray(gofers)).toBe(true);
    },
    CONTRACT_TIMEOUT_MS,
  );
});

/** Give a clear conclusion when the deployment is unreachable, instead of throwing a bare fetch error at whoever reads the log */
async function assertServerReachable(baseUrl: string): Promise<void> {
  try {
    // Only care about reachability, not the status code: only a network-layer throw means the address is unreachable
    await fetch(new URL('/api/health', baseUrl), { method: 'GET' });
  } catch (error) {
    throw new Error(
      `OAN server unreachable: ${baseUrl} (OAN_CONTRACT_BASE_URL). Contract tests need this address to be accessible. ` +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
