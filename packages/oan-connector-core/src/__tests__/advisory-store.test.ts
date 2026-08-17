import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claimAdvisory } from '../advisory-store.js';

// One-shot advisory markers: true on first claim, false forever after, effective across "instances" (same file)
describe('advisory-store', () => {
  it('首次认领 true，重复认领 false，不同 key 独立', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'oan-advisory-')), 'oan', 'advisories.json');
    expect(await claimAdvisory(file, 'heartbeat-disabled')).toBe(true);
    expect(await claimAdvisory(file, 'heartbeat-disabled')).toBe(false);
    expect(await claimAdvisory(file, 'another-topic')).toBe(true);
  });

  it('文件缺失/损坏当空表，不抛错', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'oan-advisory-')), 'nested', 'advisories.json');
    expect(await claimAdvisory(file, 'k')).toBe(true);
  });
});
