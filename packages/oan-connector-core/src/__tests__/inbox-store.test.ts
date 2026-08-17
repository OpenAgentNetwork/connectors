import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  countPendingInboxItems,
  listPendingInboxItems,
  markInboxItemsHandled,
  pruneHandledInboxItems,
  stageInboxItem,
} from '../inbox-store.js';

describe('inbox-store', () => {
  let dir = '';
  let filePath = '';

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function freshStore(): Promise<void> {
    dir = await mkdtemp(path.join(os.tmpdir(), 'oan-inbox-'));
    filePath = path.join(dir, 'inbox.json');
  }

  function makeItem(eventId: string, receivedAt: string) {
    return {
      eventId,
      contactId: 'oan:g1',
      kind: 'message' as const,
      body: `body-${eventId}`,
      receivedAt,
    };
  }

  it('入库并按 receivedAt 升序列出 pending', async () => {
    await freshStore();
    expect(await stageInboxItem(filePath, makeItem('e2', '2026-08-09T02:00:00.000Z'))).toBe('staged');
    expect(await stageInboxItem(filePath, makeItem('e1', '2026-08-09T01:00:00.000Z'))).toBe('staged');
    expect(await stageInboxItem(filePath, makeItem('e3', '2026-08-09T03:00:00.000Z'))).toBe('staged');

    const listed = await listPendingInboxItems(filePath);
    expect(listed.map((item) => item.eventId)).toEqual(['e1', 'e2', 'e3']);
    expect(listed[0]?.status).toBe('pending');
  });

  it('同 eventId 重复入库判 duplicate 且不覆盖原内容', async () => {
    await freshStore();
    await stageInboxItem(filePath, makeItem('e1', '2026-08-09T01:00:00.000Z'));
    expect(
      await stageInboxItem(filePath, { ...makeItem('e1', '2026-08-09T09:00:00.000Z'), body: 'overwrite' }),
    ).toBe('duplicate');
    const listed = await listPendingInboxItems(filePath);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.body).toBe('body-e1');
    expect(listed[0]?.receivedAt).toBe('2026-08-09T01:00:00.000Z');
  });

  it('已 handled 的 eventId 重投仍判 duplicate（不复活为 pending）', async () => {
    await freshStore();
    await stageInboxItem(filePath, makeItem('e1', '2026-08-09T01:00:00.000Z'));
    await markInboxItemsHandled(filePath, ['e1']);
    expect(await stageInboxItem(filePath, makeItem('e1', '2026-08-09T02:00:00.000Z'))).toBe('duplicate');
    expect(await listPendingInboxItems(filePath)).toEqual([]);
  });

  it('countPendingInboxItems 只计 pending', async () => {
    await freshStore();
    await stageInboxItem(filePath, makeItem('e1', '2026-08-09T01:00:00.000Z'));
    await stageInboxItem(filePath, makeItem('e2', '2026-08-09T02:00:00.000Z'));
    await markInboxItemsHandled(filePath, ['e1']);
    expect(await countPendingInboxItems(filePath)).toBe(1);
  });

  it('批量标记 handled 写入 handledAt，不存在的 eventId 静默跳过', async () => {
    await freshStore();
    await stageInboxItem(filePath, makeItem('e1', '2026-08-09T01:00:00.000Z'));
    await stageInboxItem(filePath, makeItem('e2', '2026-08-09T02:00:00.000Z'));
    await markInboxItemsHandled(filePath, ['e1', 'missing', 'e2']);

    expect(await listPendingInboxItems(filePath)).toEqual([]);
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as Record<
      string,
      { status: string; handledAt?: string }
    >;
    expect(raw['e1']?.status).toBe('handled');
    expect(raw['e1']?.handledAt).toBeTruthy();
    expect(raw['e2']?.status).toBe('handled');
    expect('missing' in raw).toBe(false);
  });

  it('修剪只动 handled，保留最近 keep 条，pending 永不修剪', async () => {
    await freshStore();
    // 4 handled items (each with a distinct handledAt) + 1 pending
    for (let i = 1; i <= 4; i += 1) {
      await stageInboxItem(filePath, makeItem(`h${i}`, `2026-08-09T0${i}:00:00.000Z`));
    }
    await stageInboxItem(filePath, makeItem('p1', '2026-08-09T05:00:00.000Z'));
    // Mark handled one at a time to get increasing handledAt values; rewrite the file directly to make the order deterministic
    await markInboxItemsHandled(filePath, ['h1', 'h2', 'h3', 'h4']);
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, { handledAt?: string }>;
    for (let i = 1; i <= 4; i += 1) {
      raw[`h${i}`]!.handledAt = `2026-08-09T1${i}:00:00.000Z`;
    }
    await writeFile(filePath, JSON.stringify(raw, null, 2), 'utf8');

    await pruneHandledInboxItems(filePath, { keep: 2 });

    const after = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
    // The newest-handled h3/h4 are kept, the oldest h1/h2 are pruned, and pending is untouched
    expect(Object.keys(after).sort()).toEqual(['h3', 'h4', 'p1']);
    expect(await countPendingInboxItems(filePath)).toBe(1);
  });

  it('handled 数量不超过 keep 时修剪不改动文件', async () => {
    await freshStore();
    await stageInboxItem(filePath, makeItem('e1', '2026-08-09T01:00:00.000Z'));
    await markInboxItemsHandled(filePath, ['e1']);
    await pruneHandledInboxItems(filePath);
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(raw)).toEqual(['e1']);
  });

  it('损坏文件当空表并在下次写入自愈', async () => {
    await freshStore();
    await writeFile(filePath, 'not-json{{{', 'utf8');
    expect(await listPendingInboxItems(filePath)).toEqual([]);
    expect(await countPendingInboxItems(filePath)).toBe(0);
    expect(await stageInboxItem(filePath, makeItem('e1', '2026-08-09T01:00:00.000Z'))).toBe('staged');
    const listed = await listPendingInboxItems(filePath);
    expect(listed).toHaveLength(1);
  });

  it('目标目录不存在时入库自动创建', async () => {
    await freshStore();
    filePath = path.join(dir, 'nested', 'deep', 'inbox.json');
    expect(await stageInboxItem(filePath, makeItem('e1', '2026-08-09T01:00:00.000Z'))).toBe('staged');
    expect(await countPendingInboxItems(filePath)).toBe(1);
  });
});
