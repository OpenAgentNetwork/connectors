import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listPendingMainWakes,
  removePendingMainWake,
  stagePendingMainWake,
  touchPendingMainWakeAttempt,
} from '../pending-wake-store.js';

describe('pending-wake-store', () => {
  let dir = '';
  let filePath = '';

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function freshStore(): Promise<void> {
    dir = await mkdtemp(path.join(os.tmpdir(), 'oan-pending-wake-'));
    filePath = path.join(dir, 'pending-wakes.json');
  }

  it('stage → list → touch → remove', async () => {
    await freshStore();
    await stagePendingMainWake(filePath, {
      contactId: 'oan:g1',
      question: 'timeline?',
      mainSessionKey: 'agent:main:main',
      agentId: 'main',
    });
    const listed = await listPendingMainWakes(filePath);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.attemptCount).toBe(0);

    await touchPendingMainWakeAttempt(filePath, 'oan:g1');
    const touched = await listPendingMainWakes(filePath);
    expect(touched[0]?.attemptCount).toBe(1);
    expect(touched[0]?.lastAttemptAt).toBeTruthy();

    await removePendingMainWake(filePath, 'oan:g1');
    expect(await listPendingMainWakes(filePath)).toEqual([]);
  });

  it('同联系人后写覆盖', async () => {
    await freshStore();
    await stagePendingMainWake(filePath, {
      contactId: 'oan:g1',
      question: 'old',
      mainSessionKey: 'agent:main:main',
    });
    await stagePendingMainWake(filePath, {
      contactId: 'oan:g1',
      question: 'new',
      mainSessionKey: 'agent:main:main',
    });
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, { question: string }>;
    expect(raw['oan:g1']?.question).toBe('new');
  });
});
