// inbound-dispatch.ts (inbox architecture): an inbound draft gets pure "intake clerk"
// treatment — attachment persistence, inbox staging (eventId dedup), pending-ledger opening,
// and a wake request; no host session turn is ever triggered.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  intakeInboundDraft,
  shouldWakeAgent,
  type InboundIntakeDeps,
  type OanAutoReplyMode,
} from '../inbound-dispatch.js';
import { listPendingInboxItems } from '../inbox-store.js';
import type { OanInboundMediaStager } from '../media.js';
import { mapEnvelopeToInboundMessage } from '../inbound-mapping.js';
import type { InboundMediaRef, InboundMessageDraft } from '../inbound-mapping.js';

function makeDraft(overrides: Partial<InboundMessageDraft> = {}): InboundMessageDraft {
  return {
    contactId: 'oan:gofer-1',
    text: 'Hello from Gofer',
    kind: 'message',
    decision: false,
    untrusted: false,
    createdAt: '2026-08-09T00:00:00.000Z',
    sourceEventId: 'evt-1',
    eventType: 'gofer_message',
    expectsReply: false,
    ...overrides,
  };
}

const mediaRef: InboundMediaRef = {
  attachmentId: 'a1',
  kind: 'document',
  name: 'notes.pdf',
  context: 'conversation',
  conversationId: 'conv-7',
};

describe('shouldWakeAgent（唤醒档位判定）', () => {
  const modes: OanAutoReplyMode[] = ['all', 'none', 'actionable'];

  it('all 恒真；none 恒假', () => {
    const drafts = [
      makeDraft(),
      makeDraft({ eventType: 'gofer_question', kind: 'question', expectsReply: true }),
      makeDraft({ eventType: 'session_summary', kind: 'notice' }),
    ];
    for (const draft of drafts) {
      expect(shouldWakeAgent(draft, 'all')).toBe(true);
      expect(shouldWakeAgent(draft, 'none')).toBe(false);
    }
    // The modes array only confirms the tier enum is exhaustive (a compile-time constraint)
    expect(modes).toHaveLength(3);
  });

  // Two-way disposition: every message in the account's own Gofer conversations must end in
  // "reply to the Gofer or brief the user", so the actionable tier wakes on gofer_message /
  // gofer_question wholesale, no longer consulting the question-mark heuristic
  it('actionable：Gofer 对话的一切消息 / decision / 对方主人来话命中为真', () => {
    expect(shouldWakeAgent(makeDraft(), 'actionable')).toBe(true);
    expect(shouldWakeAgent(makeDraft({ eventType: 'gofer_question', kind: 'question', expectsReply: true }), 'actionable')).toBe(true);
    expect(shouldWakeAgent(makeDraft({ eventType: 'match_request', kind: 'notice', decision: true }), 'actionable')).toBe(true);
    expect(shouldWakeAgent(makeDraft({ eventType: 'pair_proposed', kind: 'notice', decision: true }), 'actionable')).toBe(true);
    expect(shouldWakeAgent(makeDraft({ eventType: 'relay_message' }), 'actionable')).toBe(true);
  });

  // Real conversations died in production to "no question mark → classified as pure
  // acknowledgment/context" filtering (type filters, the question-mark heuristic, LLM
  // misclassification) — question-mark-free invitations and acknowledgments must also reach
  // the agent for disposition
  it('actionable：无问号的 gofer_message（邀请句/确认语）也唤醒，且不误开挂账', () => {
    const draft = mapEnvelopeToInboundMessage({
      v: 1,
      seq: '9',
      eventId: 'evt-9',
      type: 'gofer_message',
      source: 'own_gofer',
      goferId: 'g1',
      payload: { content: 'Feel free to share more details whenever you are ready.' },
      createdAt: '2026-08-09T00:00:00.000Z',
    });
    expect(draft.expectsReply).toBe(false); // The question-mark heuristic only serves the pending-reply ledger; it no longer decides waking
    expect(shouldWakeAgent(draft, 'actionable')).toBe(true);
  });

  // Profile-building questions arrive as gofer_message rather than gofer_question — wholesale
  // waking covers them naturally; expectsReply (the question-mark heuristic) is retained for
  // the pending-reply watchdog
  it('actionable：建档期提问（gofer_message 含问号）唤醒且 expectsReply=true', () => {
    const draft = mapEnvelopeToInboundMessage({
      v: 1,
      seq: '10',
      eventId: 'evt-9b',
      type: 'gofer_message',
      source: 'own_gofer',
      goferId: 'g1',
      payload: { content: 'What terms do you want?' },
      createdAt: '2026-08-09T00:00:00.000Z',
    });
    expect(draft.expectsReply).toBe(true);
    expect(shouldWakeAgent(draft, 'actionable')).toBe(true);
  });

  it('actionable：纯平台通知不唤醒（含无 reply 的自动配对通知）', () => {
    expect(shouldWakeAgent(makeDraft({ eventType: 'session_summary', kind: 'notice' }), 'actionable')).toBe(false);
    expect(shouldWakeAgent(makeDraft({ eventType: 'match_decided', kind: 'notice' }), 'actionable')).toBe(false);
    expect(shouldWakeAgent(makeDraft({ eventType: 'system_notice', kind: 'notice' }), 'actionable')).toBe(false);
    // Automatic pairing (decision=false) used to wake via raw-type matching — now it follows the mapping layer's judgment and does not wake
    expect(shouldWakeAgent(makeDraft({ eventType: 'pair_proposed', kind: 'notice' }), 'actionable')).toBe(false);
  });

  // Decision vs. pure-notification split verified through the real mapping: match_request is always a decision; pair_proposed only when it carries a reply
  it('actionable：pair_proposed 依信封 reply 分流——带 reply 唤醒，无 reply 纯通知不唤醒', () => {
    const baseEnvelope = {
      v: 1,
      seq: '10',
      eventId: 'evt-10',
      type: 'pair_proposed' as const,
      source: 'platform' as const,
      goferId: 'g1',
      payload: { counterpartRoleName: 'Counterpart' },
      createdAt: '2026-08-09T00:00:00.000Z',
    };
    const proposal = mapEnvelopeToInboundMessage({
      ...baseEnvelope,
      reply: { method: 'POST' as const, path: '/threads/t1/pair/confirm' },
    });
    expect(proposal.decision).toBe(true);
    expect(shouldWakeAgent(proposal, 'actionable')).toBe(true);

    const autoPair = mapEnvelopeToInboundMessage({ ...baseEnvelope, eventId: 'evt-11' });
    expect(autoPair.decision).toBe(false);
    expect(autoPair.text).toContain('No action needed');
    expect(shouldWakeAgent(autoPair, 'actionable')).toBe(false);

    const matchRequest = mapEnvelopeToInboundMessage({
      ...baseEnvelope,
      eventId: 'evt-12',
      type: 'match_request' as const,
      payload: { requestId: 'r1', counterpartRoleName: 'Counterpart' },
    });
    expect(matchRequest.decision).toBe(true);
    expect(shouldWakeAgent(matchRequest, 'actionable')).toBe(true);
  });
});

describe('intakeInboundDraft（入库员）', () => {
  let dir = '';
  let inboxPath = '';

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function freshInbox(): Promise<void> {
    dir = await mkdtemp(path.join(os.tmpdir(), 'oan-intake-'));
    inboxPath = path.join(dir, 'inbox.json');
  }

  function makeDeps(overrides: Partial<InboundIntakeDeps> = {}): InboundIntakeDeps {
    return {
      inboxPath,
      ...overrides,
    };
  }

  // Read the file directly to check final item state (listPendingInboxItems only sees pending; handled items require the raw store)
  async function readRawInbox(): Promise<Record<string, { status: string; body: string }>> {
    return JSON.parse(await readFile(inboxPath, 'utf8')) as Record<string, { status: string; body: string }>;
  }

  it('消息入库：条目出现在 pending 列表，字段一一对应', async () => {
    await freshInbox();
    await intakeInboundDraft(makeDeps(), makeDraft());

    const listed = await listPendingInboxItems(inboxPath);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      eventId: 'evt-1',
      contactId: 'oan:gofer-1',
      kind: 'message',
      body: 'Hello from Gofer',
      receivedAt: '2026-08-09T00:00:00.000Z',
      status: 'pending',
    });
  });

  it('kind 映射：draft.decision → decision；notice → event；其余 → message', async () => {
    await freshInbox();
    await intakeInboundDraft(
      makeDeps(),
      makeDraft({ sourceEventId: 'e-match', eventType: 'match_request', kind: 'notice', decision: true }),
    );
    await intakeInboundDraft(
      makeDeps(),
      makeDraft({ sourceEventId: 'e-pair', eventType: 'pair_proposed', kind: 'notice', decision: true }),
    );
    // Reply-less automatic pairing: the mapping layer sets decision=false → a pure notification (event), not a pending decision
    await intakeInboundDraft(
      makeDeps(),
      makeDraft({ sourceEventId: 'e-pair-auto', eventType: 'pair_proposed', kind: 'notice' }),
    );
    await intakeInboundDraft(
      makeDeps(),
      makeDraft({ sourceEventId: 'e-notice', eventType: 'system_notice', kind: 'notice' }),
    );
    await intakeInboundDraft(
      makeDeps(),
      makeDraft({ sourceEventId: 'e-question', eventType: 'gofer_question', kind: 'question' }),
    );

    const byId = new Map((await listPendingInboxItems(inboxPath)).map((item) => [item.eventId, item.kind]));
    expect(byId.get('e-match')).toBe('decision');
    expect(byId.get('e-pair')).toBe('decision');
    expect(byId.get('e-pair-auto')).toBe('event');
    expect(byId.get('e-notice')).toBe('event');
    expect(byId.get('e-question')).toBe('message');
  });

  it('eventId 去重：同 draft 二次入库，开账/唤醒只发生一次，收件箱仍只有一条', async () => {
    await freshInbox();
    const open = vi.fn();
    const requestWake = vi.fn();
    const deps = makeDeps({ pendingLedger: { open }, requestWake });
    const draft = makeDraft({ expectsReply: true, excerpt: 'What terms?' });

    await intakeInboundDraft(deps, draft);
    await intakeInboundDraft(deps, draft);

    expect(open).toHaveBeenCalledTimes(1);
    expect(requestWake).toHaveBeenCalledTimes(1);
    expect(await listPendingInboxItems(inboxPath)).toHaveLength(1);
  });

  it('非唤醒条目（actionable + 普通 notice）：入库即 handled，不开账不唤醒', async () => {
    await freshInbox();
    const open = vi.fn();
    const requestWake = vi.fn();
    await intakeInboundDraft(
      makeDeps({ autoReply: 'actionable', pendingLedger: { open }, requestWake }),
      makeDraft({ eventType: 'session_summary', kind: 'notice' }),
    );

    // Staging happens unconditionally (context tail), but marked handled immediately — never pending work
    expect(await listPendingInboxItems(inboxPath)).toEqual([]);
    const raw = await readRawInbox();
    expect(raw['evt-1']?.status).toBe('handled');
    expect(open).not.toHaveBeenCalled();
    expect(requestWake).not.toHaveBeenCalled();
  });

  it('唤醒条目 + expectsReply：以 (contactId, sourceEventId, excerpt) 开账并请求唤醒，条目保持 pending', async () => {
    await freshInbox();
    const open = vi.fn();
    const requestWake = vi.fn();
    await intakeInboundDraft(
      makeDeps({ pendingLedger: { open }, requestWake }),
      makeDraft({ expectsReply: true, excerpt: 'Team background?' }),
    );

    expect(open).toHaveBeenCalledWith('oan:gofer-1', 'evt-1', 'Team background?');
    expect(requestWake).toHaveBeenCalledTimes(1);
    const listed = await listPendingInboxItems(inboxPath);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toBe('pending');
  });

  it('附件落盘：条目携带改写后正文与本地媒体路径（落盘器拿到归属联系人）', async () => {
    await freshInbox();
    const stageInboundMedia = vi.fn(async () => ({
      media: [{ path: '/tmp/a.pdf' }],
      text: '改写后的正文',
      unavailable: [],
    })) as unknown as OanInboundMediaStager;
    await intakeInboundDraft(
      makeDeps({ stageInboundMedia }),
      makeDraft({ media: [mediaRef], text: '原始正文' }),
    );

    expect(stageInboundMedia).toHaveBeenCalledWith([mediaRef], '原始正文', 'oan:gofer-1');
    const listed = await listPendingInboxItems(inboxPath);
    expect(listed[0]?.body).toBe('改写后的正文');
    expect(listed[0]?.mediaPaths).toEqual(['/tmp/a.pdf']);
  });

  it('附件落盘抛错：条目仍入库，正文用原文且不带 mediaPaths', async () => {
    await freshInbox();
    const warn = vi.fn();
    const stageInboundMedia = vi.fn(async () => {
      throw new Error('download failed');
    }) as unknown as OanInboundMediaStager;
    await intakeInboundDraft(
      makeDeps({ stageInboundMedia, log: { warn } }),
      makeDraft({ media: [mediaRef], text: '原始正文' }),
    );

    const listed = await listPendingInboxItems(inboxPath);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.body).toBe('原始正文');
    expect(listed[0]?.mediaPaths).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('requestWake 抛错：不上抛，条目仍 pending', async () => {
    await freshInbox();
    const warn = vi.fn();
    const requestWake = vi.fn(() => {
      throw new Error('wake queue down');
    });
    await expect(
      intakeInboundDraft(makeDeps({ requestWake, log: { warn } }), makeDraft()),
    ).resolves.toBeUndefined();

    expect(await listPendingInboxItems(inboxPath)).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('入库失败（收件箱路径不可写）：不上抛，log.error 记录', async () => {
    await freshInbox();
    // Point inboxPath at a subpath under a regular file: mkdir is guaranteed to fail with ENOTDIR
    const blocker = path.join(dir, 'blocker');
    await writeFile(blocker, 'not a directory', 'utf8');
    const error = vi.fn();
    const requestWake = vi.fn();
    await expect(
      intakeInboundDraft(
        makeDeps({ inboxPath: path.join(blocker, 'sub', 'inbox.json'), requestWake, log: { error } }),
        makeDraft(),
      ),
    ).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledTimes(1);
    // A staging failure terminates the flow: waking must not proceed
    expect(requestWake).not.toHaveBeenCalled();
  });
});
