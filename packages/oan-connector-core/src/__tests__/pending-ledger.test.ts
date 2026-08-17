// Pending-reply ledger: open/close, revival from persistence, and reminder sweep cadence
// (aggregated notes). The reminder note's "how to end an idle turn" wording is an injected
// slot — one test for the neutral default, one for injection taking effect.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildPendingReminderNote,
  DEFAULT_REMINDER_IDLE_EXIT_INSTRUCTION,
  PendingExchangeLedger,
  sweepPendingReminders,
} from '../pending-ledger.js';

const dirs: string[] = [];

function ledgerInTemp(): { ledger: PendingExchangeLedger; filePath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'oan-ledger-'));
  dirs.push(dir);
  const filePath = path.join(dir, 'pending-ledger-default.json');
  return { ledger: new PendingExchangeLedger(filePath), filePath };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('PendingExchangeLedger', () => {
  it('开账后可列出；销账返回 true 并清空；未开账的销账返回 false', async () => {
    const { ledger } = ledgerInTemp();
    await ledger.open('oan:g1', 'evt-1', 'What terms do you want?');
    expect(ledger.list()).toHaveLength(1);
    expect(ledger.list()[0]).toMatchObject({ contactId: 'oan:g1', sourceEventId: 'evt-1', reminders: 0 });

    expect(await ledger.close('oan:g1')).toBe(true);
    expect(ledger.list()).toEqual([]);
    expect(await ledger.close('oan:g1')).toBe(false);
  });

  it('同一联系人重复开账只保留最新一笔（新问题覆盖旧问题）', async () => {
    const { ledger } = ledgerInTemp();
    await ledger.open('oan:g1', 'evt-1', 'first question?');
    await ledger.open('oan:g1', 'evt-2', 'second question?');
    expect(ledger.list()).toHaveLength(1);
    expect(ledger.list()[0].sourceEventId).toBe('evt-2');
  });

  it('欠账随持久化文件在新实例 load() 后复活（连接器重启存活）', async () => {
    const { ledger, filePath } = ledgerInTemp();
    await ledger.open('oan:g1', 'evt-1', 'still owed?');

    const reborn = new PendingExchangeLedger(filePath);
    await reborn.load();
    expect(reborn.list()).toHaveLength(1);
    expect(reborn.list()[0]).toMatchObject({ contactId: 'oan:g1', excerpt: 'still owed?' });
  });

  it('持久化文件缺失或损坏时空账启动，不抛错', async () => {
    const { ledger } = ledgerInTemp();
    await ledger.load();
    expect(ledger.list()).toEqual([]);
  });

  it('摘录超长时截断到 200 字符', async () => {
    const { ledger } = ledgerInTemp();
    await ledger.open('oan:g1', 'evt-1', 'x'.repeat(500));
    expect(ledger.list()[0].excerpt).toHaveLength(200);
  });
});

describe('sweepPendingReminders（催账节奏：5/30 分钟两档、每账至多两次、聚合单条注记）', () => {
  async function agedLedger(sinceMsAgo: number, reminders: number) {
    const { ledger } = ledgerInTemp();
    await ledger.open('oan:g1', 'evt-1', 'aged question?', new Date(Date.now() - sinceMsAgo));
    for (let i = 0; i < reminders; i++) await ledger.recordReminder('oan:g1');
    return ledger;
  }

  it('开账不足 5 分钟：不催', async () => {
    const ledger = await agedLedger(2 * 60_000, 0);
    const notify = vi.fn().mockReturnValue('queued' as const);
    await sweepPendingReminders(ledger, notify, Date.now());
    expect(notify).not.toHaveBeenCalled();
  });

  it('超 5 分钟未催过：第一次催，并计数', async () => {
    const ledger = await agedLedger(6 * 60_000, 0);
    const notify = vi.fn().mockReturnValue('queued' as const);
    await sweepPendingReminders(ledger, notify, Date.now());
    expect(notify).toHaveBeenCalledTimes(1);
    expect(ledger.list()[0].reminders).toBe(1);
    // Sweep again immediately: short of the 30-minute tier, no repeat reminder
    await sweepPendingReminders(ledger, notify, Date.now());
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('超 30 分钟且已催一次：第二次（最后一次）催；此后不再催', async () => {
    const ledger = await agedLedger(31 * 60_000, 1);
    const notify = vi.fn().mockReturnValue('queued' as const);
    await sweepPendingReminders(ledger, notify, Date.now());
    expect(notify).toHaveBeenCalledTimes(1);
    expect(ledger.list()[0].reminders).toBe(2);
    await sweepPendingReminders(ledger, notify, Date.now());
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('多个联系人同时到期：只发一条聚合注记，文案含全部联系人，且每个条目都计数', async () => {
    const { ledger } = ledgerInTemp();
    const since = new Date(Date.now() - 6 * 60_000);
    await ledger.open('oan:g1', 'evt-1', 'first owed?', since);
    await ledger.open('oan:g2', 'evt-2', 'second owed?', since);

    const notify = vi.fn().mockReturnValue('queued' as const);
    await sweepPendingReminders(ledger, notify, Date.now());

    expect(notify).toHaveBeenCalledTimes(1);
    const note = notify.mock.calls[0][0] as string;
    expect(note).toContain('oan:g1');
    expect(note).toContain('oan:g2');
    const byId = new Map(ledger.list().map((e) => [e.contactId, e]));
    expect(byId.get('oan:g1')?.reminders).toBe(1);
    expect(byId.get('oan:g2')?.reminders).toBe(1);
  });

  it('notify 返回 duplicate：不消耗催账档位（下轮仍会重试）', async () => {
    const ledger = await agedLedger(6 * 60_000, 0);
    const notify = vi.fn().mockReturnValue('duplicate' as const);
    await sweepPendingReminders(ledger, notify, Date.now());
    expect(notify).toHaveBeenCalledTimes(1);
    expect(ledger.list()[0].reminders).toBe(0);
  });

  it('notify 返回 failed：不消耗催账档位（宿主不可用不算催过）', async () => {
    const ledger = await agedLedger(6 * 60_000, 0);
    const notify = vi.fn().mockReturnValue('failed' as const);
    await sweepPendingReminders(ledger, notify, Date.now());
    expect(notify).toHaveBeenCalledTimes(1);
    expect(ledger.list()[0].reminders).toBe(0);
  });

  it('sweep 把注记槽位透传给文案（宿主收尾指引进聚合注记）', async () => {
    const ledger = await agedLedger(6 * 60_000, 0);
    const notify = vi.fn().mockReturnValue('queued' as const);
    await sweepPendingReminders(ledger, notify, Date.now(), {
      idleExitInstruction: 'HOST-IDLE-RULE.',
    });
    expect(notify.mock.calls[0][0] as string).toContain('HOST-IDLE-RULE.');
  });

  it('催账文案：逐条指名联系人与问题、给出 oan_reply 唯一送达路、缺省中性收尾指引、禁 curl', () => {
    const note = buildPendingReminderNote([
      {
        contactId: 'oan:g1',
        sourceEventId: 'evt-1',
        excerpt: 'What terms?',
        since: '2026-08-06T00:00:00.000Z',
        reminders: 0,
      },
    ]);
    expect(note).toContain('oan:g1');
    expect(note).toContain('What terms?');
    expect(note).toContain('oan_reply');
    expect(note).toContain('curl');
    // Neutral default: names no host sentinel, only says "end the turn idle per the host's convention"
    expect(note).toContain(DEFAULT_REMINDER_IDLE_EXIT_INSTRUCTION);
  });

  it('注入宿主收尾指引后替换中性缺省（宿主哨兵约定只能从外部进来）', () => {
    const note = buildPendingReminderNote(
      [
        {
          contactId: 'oan:g1',
          sourceEventId: 'evt-1',
          excerpt: 'q?',
          since: '2026-08-06T00:00:00.000Z',
          reminders: 0,
        },
      ],
      { idleExitInstruction: 'End with the host idle marker in an idle turn.' },
    );
    expect(note).toContain('End with the host idle marker in an idle turn.');
    expect(note).not.toContain(DEFAULT_REMINDER_IDLE_EXIT_INSTRUCTION);
  });
});

describe('markEscalated（升级标记影响催账文案分支）', () => {
  it('标记后条目携带 escalatedAt 且持久化', async () => {
    const { ledger, filePath } = ledgerInTemp();
    await ledger.open('oan:g1', 'evt-1', 'q?');
    await ledger.markEscalated('oan:g1');
    expect(ledger.list()[0].escalatedAt).toBeTruthy();

    const reborn = new PendingExchangeLedger(filePath);
    await reborn.load();
    expect(reborn.list()[0].escalatedAt).toBeTruthy();
  });

  it('未升级条目标注"尚未转告主人"；已升级条目标注转告时间；两种状态可同列一条注记', () => {
    const base = {
      contactId: 'oan:g1',
      sourceEventId: 'evt-1',
      excerpt: 'q?',
      since: '2026-08-06T00:00:00.000Z',
      reminders: 0,
    };
    expect(buildPendingReminderNote([base])).toContain('not yet relayed to your user');

    const escalated = { ...base, contactId: 'oan:g2', escalatedAt: '2026-08-06T00:05:00.000Z' };
    const note = buildPendingReminderNote([base, escalated]);
    expect(note).toContain('not yet relayed to your user');
    expect(note).toContain('already relayed to your user at 2026-08-06T00:05:00.000Z');
  });
});
