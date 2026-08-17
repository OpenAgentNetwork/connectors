// Connection liveness file: written by the connected process, readable by any instance — the cross-instance source of truth for connection state
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isLivenessFresh,
  readLiveness,
  writeLiveness,
  OAN_LIVENESS_FRESH_MS,
} from '../liveness-store.js';

describe('liveness-store', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'oan-liveness-'));
    filePath = path.join(dir, 'nested', 'liveness-default.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('写读回环（目录自动创建），缺失/损坏返回 undefined', async () => {
    expect(await readLiveness(filePath)).toBeUndefined();
    const record = {
      state: 'connected' as const,
      baseUrl: 'https://api.example',
      lastAliveAt: new Date().toISOString(),
      connectedAt: new Date().toISOString(),
    };
    await writeLiveness(filePath, record);
    expect(await readLiveness(filePath)).toEqual(record);
  });

  it('新鲜度判定：写盘周期 2.5 倍内算活着，超过即过期', () => {
    const now = Date.now();
    const fresh = { state: 'connected' as const, lastAliveAt: new Date(now - OAN_LIVENESS_FRESH_MS + 1000).toISOString() };
    const stale = { state: 'connected' as const, lastAliveAt: new Date(now - OAN_LIVENESS_FRESH_MS - 1000).toISOString() };
    expect(isLivenessFresh(fresh, now)).toBe(true);
    expect(isLivenessFresh(stale, now)).toBe(false);
    expect(isLivenessFresh({ state: 'connected', lastAliveAt: 'not-a-date' }, now)).toBe(false);
  });

  it('stopped 记录带原因', async () => {
    await writeLiveness(filePath, {
      state: 'stopped',
      lastAliveAt: new Date().toISOString(),
      stoppedReason: 'account_banned',
    });
    expect((await readLiveness(filePath))?.stoppedReason).toBe('account_banned');
  });
});
