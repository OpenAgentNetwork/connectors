// Single-machine two-instance lock: live locks refused, stale locks (dead pid / expired heartbeat) taken over, only our own lock released.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimInstanceLock, releaseInstanceLock, touchInstanceLock, OAN_LOCK_FRESH_MS } from '../runtime.js';

let dir: string;
let lockPath: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'oan-dsh-lock-'));
  lockPath = path.join(dir, 'lock.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NOW = 1_000_000_000_000;

describe('claimInstanceLock', () => {
  it('无锁文件：直接认领并写盘', async () => {
    const result = await claimInstanceLock(lockPath, { pid: 100, now: NOW, isPidAlive: () => true });
    expect(result).toEqual({ claimed: true });
    const record = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number };
    expect(record.pid).toBe(100);
  });

  it('活锁（pid 存活且心跳新鲜）：拒绝并报告持有者', async () => {
    await writeFile(lockPath, JSON.stringify({ pid: 200, touchedAt: new Date(NOW - 10_000).toISOString() }));
    const result = await claimInstanceLock(lockPath, { pid: 100, now: NOW, isPidAlive: () => true });
    expect(result).toEqual({ claimed: false, holderPid: 200 });
  });

  it('陈旧锁：持有 pid 已死 → 接管', async () => {
    await writeFile(lockPath, JSON.stringify({ pid: 200, touchedAt: new Date(NOW - 10_000).toISOString() }));
    const result = await claimInstanceLock(lockPath, { pid: 100, now: NOW, isPidAlive: () => false });
    expect(result).toEqual({ claimed: true });
    expect((JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number }).pid).toBe(100);
  });

  it('陈旧锁：心跳过期（超过新鲜窗口）→ 即使 pid 存活也接管', async () => {
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 200, touchedAt: new Date(NOW - OAN_LOCK_FRESH_MS - 1).toISOString() }),
    );
    const result = await claimInstanceLock(lockPath, { pid: 100, now: NOW, isPidAlive: () => true });
    expect(result).toEqual({ claimed: true });
  });

  it('损坏的锁文件视为无锁', async () => {
    await writeFile(lockPath, 'not-json');
    const result = await claimInstanceLock(lockPath, { pid: 100, now: NOW, isPidAlive: () => true });
    expect(result).toEqual({ claimed: true });
  });
});

describe('touch / release', () => {
  it('touch 只在锁属于自己时刷新', async () => {
    await writeFile(lockPath, JSON.stringify({ pid: 200, touchedAt: new Date(0).toISOString() }));
    await touchInstanceLock(lockPath, 100);
    expect((JSON.parse(await readFile(lockPath, 'utf8')) as { touchedAt: string }).touchedAt).toBe(
      new Date(0).toISOString(),
    );
    await touchInstanceLock(lockPath, 200);
    expect((JSON.parse(await readFile(lockPath, 'utf8')) as { touchedAt: string }).touchedAt).not.toBe(
      new Date(0).toISOString(),
    );
  });

  it('release 只删除属于自己的锁（绝不误删接管者的新锁）', async () => {
    await writeFile(lockPath, JSON.stringify({ pid: 200, touchedAt: new Date().toISOString() }));
    await releaseInstanceLock(lockPath, 100);
    await expect(readFile(lockPath, 'utf8')).resolves.toBeTruthy();
    await releaseInstanceLock(lockPath, 200);
    await expect(readFile(lockPath, 'utf8')).rejects.toThrow();
  });
});
