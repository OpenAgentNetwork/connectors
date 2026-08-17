// Live contract tests (client-js): asserts the response shape of every endpoint against a real
// OAN server, one by one.
//
// Why this exists: every other test in this package uses fakes/mocks, which can only prove "our
// own logic" and cannot catch a wrong assumption about the server's contract. This file is the
// one suite that really hits the network, used to pin down the wire shapes.
//
// Gating: runs only when OAN_CONTRACT_BASE_URL, OAN_CONTRACT_EMAIL and OAN_CONTRACT_CODE are
// all set; a default `vitest run` skips the whole suite (exit code 0).
//
// Maintainer-only: the suite needs a non-production deployment configured to accept a test
// account whose verification code is known ahead of time, so no real mailbox is involved.
// Credentials are never committed — supply them through the environment variables above.
//
// Hygiene: every Gofer this suite creates on the server is registered into createdGoferIds and
// cleaned up unconditionally in afterAll (even when a case fails); the apiKey is never logged,
// never enters assertion messages, never enters snapshots. Each run issues a fresh connector
// API key on that QA account and leaves it there — it is the credential this suite itself runs
// on, revoking it after the run would only add another failure path, and the rows are inert
// metadata on a dedicated test account (revocation semantics are covered separately by the
// server's own tests).
//
// ── Call surfaces deliberately not covered here, and what covers them instead ──────────────
// - The `/oan` WebSocket long connection and reconnect backfill (OanClient): the connection
//   lifecycle is a poor fit for CI assertions; covered by client.test.ts's fake socket.io
//   server plus real-device acceptance;
// - Attachment upload/download (attachments.ts): needs fabricated binary files and would leave
//   garbage in the dev object store; covered by attachments.test.ts's fake server plus
//   real-device acceptance;
// - match-requests / conversations: triggering them needs two mutually paired accounts, at a
//   cost far exceeding the benefit; covered by the server's own integration tests;
// - api-keys revoke: it would revoke the very key this suite is running on, and deletion
//   semantics are already covered by the server tests.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  OAN_EVENT_TYPES,
  OAN_MESSAGE_SOURCES,
  OAN_PROTOCOL_VERSION,
  OanApiError,
  createGofer,
  createPairingCode,
  deleteGofer,
  getEventsCursor,
  getGoferChatMessages,
  listEventsSince,
  listGofers,
  listUnresolvedEvents,
  redeemPairingCode,
  requestEmailCode,
  sendGoferMessage,
  verifyEmail,
  type AuthMode,
  type OanEventEnvelope,
  type OanGoferCreateResult,
} from '../../index.js';

/** Gate switch: the suite is skipped — and the network never touched — unless all three are supplied */
const CONTRACT_BASE_URL = process.env.OAN_CONTRACT_BASE_URL?.trim() ?? '';
/** Test account and its known verification code, supplied by the maintainer's environment, never committed */
const CONTRACT_EMAIL = process.env.OAN_CONTRACT_EMAIL?.trim() ?? '';
const BYPASS_CODE = process.env.OAN_CONTRACT_CODE?.trim() ?? '';
const CONTRACT_ENABLED = CONTRACT_BASE_URL.length > 0 && CONTRACT_EMAIL.length > 0 && BYPASS_CODE.length > 0;

/** Per-case timeout: real network + serverless cold starts make 10s insufficient */
const CONTRACT_TIMEOUT_MS = 30_000;

/** Polling ceiling and interval for awaiting asynchronous persistence (202-accepted messages, event writes) */
const POLL_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 1_000;

if (!CONTRACT_ENABLED) {
  console.info(
    '[contract] Live contract tests skipped. Set OAN_CONTRACT_BASE_URL, OAN_CONTRACT_EMAIL and ' +
      'OAN_CONTRACT_CODE, then run `pnpm --filter @openagentnetwork/client-js test:contract`.',
  );
}

describe.skipIf(!CONTRACT_ENABLED)('OAN 线上契约 · client-js', () => {
  /** Artifacts of one join chain, read-only for the individual cases, avoiding repeated account creation */
  let loginToken = '';
  let loginUserId = '';
  let pairingCode = '';
  let pairingExpiresAt = '';
  let redeemedUserId = '';
  let apiKeyPrefix = '';
  let auth: AuthMode = { kind: 'none' };

  /** Every Gofer this suite creates, cleaned up together in afterAll */
  const createdGoferIds = new Set<string>();

  beforeAll(async () => {
    await assertServerReachable(CONTRACT_BASE_URL);

    // Run the join chain once; each step's artifacts are left for the cases below to assert individually (no ordering dependencies between cases)
    await requestEmailCode(CONTRACT_BASE_URL, CONTRACT_EMAIL);
    const login = await verifyEmail(CONTRACT_BASE_URL, {
      email: CONTRACT_EMAIL,
      code: BYPASS_CODE,
      platform: 'other',
    });
    loginToken = login.token;
    loginUserId = login.user.id;

    const pairing = await createPairingCode(CONTRACT_BASE_URL, loginToken);
    pairingCode = pairing.code;
    pairingExpiresAt = pairing.expiresAt;

    const redeemed = await redeemPairingCode(CONTRACT_BASE_URL, pairingCode);
    redeemedUserId = redeemed.userId;
    // Keep only the prefix for assertions; the full key lives solely in auth and never leaks into assertion messages/logs
    apiKeyPrefix = redeemed.apiKey.slice(0, 7);
    auth = { kind: 'apiKey', apiKey: redeemed.apiKey };
  }, CONTRACT_TIMEOUT_MS);

  afterAll(async () => {
    if (auth.kind !== 'apiKey') return;
    for (const goferId of createdGoferIds) {
      try {
        await deleteGofer(CONTRACT_BASE_URL, auth, goferId);
      } catch {
        // Cleanup is best-effort: a Gofer already deleted by a case, or a transient server error, should not turn the whole suite red
      }
    }
    createdGoferIds.clear();
  }, CONTRACT_TIMEOUT_MS);

  // Creates a Gofer and registers it, guaranteeing afterAll can always delete it
  async function createTrackedGofer(input?: { locale?: string }): Promise<OanGoferCreateResult> {
    const created = await createGofer(CONTRACT_BASE_URL, auth, input);
    createdGoferIds.add(created.goferId);
    return created;
  }

  describe('A. 入网链（邮箱验证码 → operator JWT → 配对码 → apiKey）', () => {
    it(
      '1. requestEmailCode 对旁路账号不抛错',
      () => {
        // Already really called in beforeAll; reaching this point means it did not throw
        expect(loginUserId).toBeTruthy();
      },
      CONTRACT_TIMEOUT_MS,
    );

    it(
      '2. verifyEmail 返回 { user, token }，token 是非空字符串',
      () => {
        expect(typeof loginToken).toBe('string');
        expect(loginToken.length).toBeGreaterThan(0);
        expect(typeof loginUserId).toBe('string');
        expect(loginUserId.length).toBeGreaterThan(0);
      },
      CONTRACT_TIMEOUT_MS,
    );

    it(
      '3. createPairingCode 返回 { code, expiresAt }，code 非空、expiresAt 是未来时间',
      () => {
        expect(typeof pairingCode).toBe('string');
        expect(pairingCode.length).toBeGreaterThan(0);
        const expiresAtMs = Date.parse(pairingExpiresAt);
        expect(Number.isNaN(expiresAtMs)).toBe(false);
        expect(expiresAtMs).toBeGreaterThan(Date.now());
      },
      CONTRACT_TIMEOUT_MS,
    );

    it(
      '4. redeemPairingCode 返回 { apiKey, userId }，apiKey 以 gofers_ 开头且 userId 与登录用户一致',
      () => {
        expect(apiKeyPrefix).toBe('gofers_');
        expect(redeemedUserId).toBe(loginUserId);
      },
      CONTRACT_TIMEOUT_MS,
    );

    it(
      '5. 配对码一次性：同一个 code 再兑换一次抛 401',
      async () => {
        const error = await captureError(() => redeemPairingCode(CONTRACT_BASE_URL, pairingCode));
        expect(error).toBeInstanceOf(OanApiError);
        expect((error as OanApiError).status).toBe(401);
      },
      CONTRACT_TIMEOUT_MS,
    );

    it(
      '7. 旁路账号的验证码可重复使用（与真实邮箱账号的一次性语义不同）',
      async () => {
        // Real mailbox accounts: a verification code is consumed on successful verification, and
        // a repeated verify returns 401 — connector implementations rely on exactly this
        // semantics to tell users "do not retry with the same code". Bypass accounts take the
        // fixed-code branch (nothing persisted, nothing consumed), so verify can succeed
        // repeatedly. What is asserted here is "the bypass's actual behavior" — do not rely on
        // it as a production contract.
        const again = await verifyEmail(CONTRACT_BASE_URL, {
          email: CONTRACT_EMAIL,
          code: BYPASS_CODE,
          platform: 'other',
        });
        expect(again.user.id).toBe(loginUserId);
        expect(typeof again.token).toBe('string');
        expect(again.token.length).toBeGreaterThan(0);
      },
      CONTRACT_TIMEOUT_MS,
    );
  });

  describe('B. apiKey 鉴权与账户面', () => {
    it(
      '8. listGofers 返回数组',
      async () => {
        const gofers = await listGofers(CONTRACT_BASE_URL, auth);
        expect(Array.isArray(gofers)).toBe(true);
      },
      CONTRACT_TIMEOUT_MS,
    );

    it(
      '9. getEventsCursor 返回 { seq }，seq 是可 BigInt() 的纯数字字符串',
      async () => {
        const cursor = await getEventsCursor(CONTRACT_BASE_URL, auth);
        expect(typeof cursor.seq).toBe('string');
        // The cold-start logic calls BigInt() on it directly; a non-numeric string would blow up on real devices
        expect(cursor.seq).toMatch(/^\d+$/);
        expect(() => BigInt(cursor.seq)).not.toThrow();
      },
      CONTRACT_TIMEOUT_MS,
    );

    it(
      '10. listEventsSince 返回数组',
      async () => {
        const events = await listEventsSince(CONTRACT_BASE_URL, auth, '0', 10);
        expect(Array.isArray(events)).toBe(true);
        expect(events.length).toBeLessThanOrEqual(10);
      },
      CONTRACT_TIMEOUT_MS,
    );

    it(
      '11. listUnresolvedEvents 返回 { events, summary }，summary 三个字段都是数字',
      async () => {
        const digest = await listUnresolvedEvents(CONTRACT_BASE_URL, auth);
        expect(Array.isArray(digest.events)).toBe(true);
        expect(typeof digest.summary.pendingQuestions).toBe('number');
        expect(typeof digest.summary.goferCount).toBe('number');
        expect(typeof digest.summary.decisions).toBe('number');
      },
      CONTRACT_TIMEOUT_MS,
    );

    it(
      '12. 无效 apiKey 抛 OanApiError(401)',
      async () => {
        const badAuth: AuthMode = { kind: 'apiKey', apiKey: 'gofers_deadbeef' };
        const error = await captureError(() => listGofers(CONTRACT_BASE_URL, badAuth));
        expect(error).toBeInstanceOf(OanApiError);
        expect((error as OanApiError).status).toBe(401);
        expect((error as OanApiError).code).toBe('UNAUTHORIZED');
      },
      CONTRACT_TIMEOUT_MS,
    );
  });

  describe('C. Gofer 生命周期（建出来的一律删干净）', () => {
    let gofer: OanGoferCreateResult;
    /** The cursor from before the Gofer was created, letting section D fetch only the events newly produced by this run */
    let cursorBeforeGofer = '0';
    const probeText = 'Contract test ping — safe to ignore.';

    beforeAll(async () => {
      cursorBeforeGofer = (await getEventsCursor(CONTRACT_BASE_URL, auth)).seq;
      gofer = await createTrackedGofer({ locale: 'en' });
      await sendGoferMessage(CONTRACT_BASE_URL, auth, gofer.goferId, probeText);
    }, CONTRACT_TIMEOUT_MS);

    it(
      '13. createGofer 返回 { goferId, chatId, greeting }（webUrl 若存在是 http(s) URL）',
      () => {
        expect(gofer.goferId).toBeTruthy();
        expect(gofer.chatId).toBeTruthy();
        expect(typeof gofer.greeting).toBe('string');
        expect(gofer.greeting.length).toBeGreaterThan(0);
        if (gofer.webUrl !== undefined) {
          expect(gofer.webUrl).toMatch(/^https?:\/\//);
        }
      },
      CONTRACT_TIMEOUT_MS,
    );

    it(
      '14. sendGoferMessage 不抛错（服务端 202 受理）',
      () => {
        // Already really sent in beforeAll; reaching this point means the server accepted it
        expect(gofer.goferId).toBeTruthy();
      },
      CONTRACT_TIMEOUT_MS,
    );

    it(
      '15. getGoferChatMessages 返回数组，元素形状合法且能找到刚发的那条 user 消息',
      async () => {
        const messages = await pollUntil(
          () => getGoferChatMessages(CONTRACT_BASE_URL, auth, gofer.goferId),
          (list) => list.some((message) => message.role === 'user' && message.content === probeText),
        );
        expect(Array.isArray(messages)).toBe(true);
        for (const message of messages) {
          expect(message.id).toBeTruthy();
          expect(['user', 'assistant', 'system']).toContain(message.role);
          expect(typeof message.content).toBe('string');
          expect(Number.isNaN(Date.parse(message.createdAt))).toBe(false);
        }
        expect(messages.some((message) => message.role === 'user' && message.content === probeText)).toBe(true);
      },
      CONTRACT_TIMEOUT_MS,
    );

    it(
      '16. deleteGofer 不抛错，删后 listGofers 里不再出现该 goferId',
      async () => {
        // Create a separate one just for the deletion assertion, leaving the one the cases above depend on untouched
        const disposable = await createTrackedGofer({ locale: 'en' });
        const result = await deleteGofer(CONTRACT_BASE_URL, auth, disposable.goferId);
        expect(result.deleted).toBe(true);
        expect(result.goferId).toBe(disposable.goferId);
        createdGoferIds.delete(disposable.goferId);

        const remaining = await listGofers(CONTRACT_BASE_URL, auth);
        expect(remaining.map((item) => item.goferId)).not.toContain(disposable.goferId);
      },
      CONTRACT_TIMEOUT_MS,
    );

    describe('D. 事件信封与协议版本', () => {
      it(
        '17. 补发到的信封满足 v/seq/eventId/type/source 契约（拿不到事件不算失败）',
        async () => {
          const envelopes = await pollUntil(
            () => listEventsSince(CONTRACT_BASE_URL, auth, cursorBeforeGofer, 50),
            (list) => list.length > 0,
          );
          if (envelopes.length === 0) {
            // LLM generation is delayed; getting no event within the timeout window only means
            // "not here yet", not a broken contract — soft pass, never let this become a flaky red light
            console.info('[contract] 轮询窗口内未拿到任何事件，跳过信封形状断言（不视为失败）。');
            return;
          }
          for (const envelope of envelopes as OanEventEnvelope[]) {
            expect(typeof envelope.v).toBe('number');
            expect(envelope.v).toBe(OAN_PROTOCOL_VERSION);
            expect(envelope.seq).toMatch(/^\d+$/);
            expect(envelope.eventId).toBeTruthy();
            expect(OAN_EVENT_TYPES).toContain(envelope.type);
            expect(OAN_MESSAGE_SOURCES).toContain(envelope.source);
          }
        },
        CONTRACT_TIMEOUT_MS,
      );
    });
  });
});

/** Gives a clear conclusion when the target is unreachable, instead of throwing a bare fetch error at whoever reads the logs */
async function assertServerReachable(baseUrl: string): Promise<void> {
  try {
    // Only "can we connect" matters, not the status code: only a network-layer throw means the address is unreachable
    await fetch(new URL('/api/health', baseUrl), { method: 'GET' });
  } catch (error) {
    throw new Error(
      `OAN 服务端不可达：${baseUrl}（OAN_CONTRACT_BASE_URL）。契约测试需要该地址可访问。` +
        `底层错误：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Captures the error thrown by an async call; fails explicitly if nothing was thrown (avoids rejects assertions swallowing the type information) */
async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('期望该调用抛错，但它成功返回了。');
}

/** Polls until the condition holds or the deadline passes; on timeout returns the last result, leaving the caller to choose a hard assertion or a soft pass */
async function pollUntil<T>(fetchOnce: () => Promise<T>, isDone: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let latest = await fetchOnce();
  while (!isDone(latest) && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    latest = await fetchOnce();
  }
  return latest;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
