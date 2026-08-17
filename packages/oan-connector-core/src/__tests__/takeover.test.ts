import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OanEventEnvelope } from '@openagentnetwork/client-js';
import { isTakeoverPending, markTakeoverPending } from '../takeover-store.js';
import { buildTakeoverNote, runTakeoverIfPending } from '../takeover.js';

function makeEnvelope(overrides: Partial<OanEventEnvelope> = {}): OanEventEnvelope {
  return {
    v: 1,
    seq: '1',
    eventId: 'evt-1',
    type: 'gofer_question',
    goferId: 'g1',
    source: 'own_gofer',
    createdAt: '2026-08-01T00:00:00.000Z',
    payload: { messageId: 'm1', content: 'What is the budget?', createdAt: '2026-08-01T00:00:00.000Z' },
    ...overrides,
  } as OanEventEnvelope;
}

describe('runTakeoverIfPending', () => {
  let dir: string;
  let storePath: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'oan-takeover-run-'));
    storePath = path.join(dir, 'takeover.json');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('标记未置位时直接跳过，不拉取', async () => {
    let fetched = 0;
    const result = await runTakeoverIfPending({
      storePath,
      fetchUnresolved: async () => { fetched += 1; return { events: [], summary: { pendingQuestions: 0, goferCount: 0, decisions: 0 } }; },
      intake: async () => {}, notify: () => {}, wake: () => {},
    });
    expect(result).toBe('skipped');
    expect(fetched).toBe(0);
  });

  it('拉取失败：返回 failed 且标记保留（下次重连重试）', async () => {
    await markTakeoverPending(storePath);
    const result = await runTakeoverIfPending({
      storePath,
      fetchUnresolved: async () => { throw new Error('network down'); },
      intake: async () => {}, notify: () => {}, wake: () => {},
    });
    expect(result).toBe('failed');
    expect(await isTakeoverPending(storePath)).toBe(true);
  });

  it('有欠账：逐条经 intake 入库（携带原始 eventId），发接管 note，唤醒，清标记', async () => {
    await markTakeoverPending(storePath);
    const drafts: string[] = [];
    const notes: Array<{ text: string; key: string }> = [];
    let woke = 0;
    const result = await runTakeoverIfPending({
      storePath,
      fetchUnresolved: async () => ({
        events: [makeEnvelope(), makeEnvelope({ eventId: 'evt-2', seq: '2', type: 'match_request', payload: { requestId: 'r1' } })],
        summary: { pendingQuestions: 1, goferCount: 1, decisions: 1 },
      }),
      intake: async (draft) => { drafts.push(draft.sourceEventId); },
      notify: (text, key) => { notes.push({ text, key }); },
      wake: () => { woke += 1; },
    });
    expect(result).toBe('seeded');
    expect(drafts).toEqual(['evt-1', 'evt-2']);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.key).toBe('oan:takeover');
    expect(woke).toBe(1);
    expect(await isTakeoverPending(storePath)).toBe(false);
  });

  it('空摘要：不发 note 不唤醒，清标记', async () => {
    await markTakeoverPending(storePath);
    let notified = 0;
    const result = await runTakeoverIfPending({
      storePath,
      fetchUnresolved: async () => ({ events: [], summary: { pendingQuestions: 0, goferCount: 0, decisions: 0 } }),
      intake: async () => {}, notify: () => { notified += 1; }, wake: () => {},
    });
    expect(result).toBe('empty');
    expect(notified).toBe(0);
    expect(await isTakeoverPending(storePath)).toBe(false);
  });
});

describe('buildTakeoverNote', () => {
  it('含计数、含 "pending OAN items" 触发短语、含先汇报再逐条的纪律', () => {
    const note = buildTakeoverNote({ pendingQuestions: 3, goferCount: 2, decisions: 1 });
    expect(note).toContain('3');
    expect(note).toContain('2');
    expect(note).toContain('1 pending decision');
    expect(note).toContain('pending OAN items');
    expect(note).toContain('one per message');
  });

  it('无决策时不出现 decision 短语', () => {
    const note = buildTakeoverNote({ pendingQuestions: 1, goferCount: 1, decisions: 0 });
    expect(note).not.toContain('decision');
  });
});
