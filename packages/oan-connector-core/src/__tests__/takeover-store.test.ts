import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearTakeoverPending, isTakeoverPending, markTakeoverPending } from '../takeover-store.js';

describe('takeover-store', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'oan-takeover-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('mark → pending=true；clear → false；重复 mark/clear 幂等', async () => {
    const file = path.join(dir, 'takeover.json');
    expect(await isTakeoverPending(file)).toBe(false);
    await markTakeoverPending(file);
    await markTakeoverPending(file);
    expect(await isTakeoverPending(file)).toBe(true);
    await clearTakeoverPending(file);
    await clearTakeoverPending(file);
    expect(await isTakeoverPending(file)).toBe(false);
  });

  it('文件缺失或损坏一律视为不待接管', async () => {
    const file = path.join(dir, 'nested', 'takeover.json');
    expect(await isTakeoverPending(file)).toBe(false);
    await writeFile(path.join(dir, 'broken.json'), '{not json', 'utf8');
    expect(await isTakeoverPending(path.join(dir, 'broken.json'))).toBe(false);
  });
});
