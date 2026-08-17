import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileCursorStore } from '../cursor-store.js';

describe('createFileCursorStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oan-core-cursor-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when no file has been persisted yet', () => {
    const store = createFileCursorStore(join(dir, 'cursor.json'));
    expect(store.restore()).toBeNull();
  });

  it('round-trips a persisted cursor', () => {
    const filePath = join(dir, 'cursor.json');
    const store = createFileCursorStore(filePath);
    store.persist('123');
    expect(existsSync(filePath)).toBe(true);
    expect(store.restore()).toBe('123');
  });

  it('creates missing parent directories on persist', () => {
    const filePath = join(dir, 'nested', 'state', 'cursor.json');
    const store = createFileCursorStore(filePath);
    store.persist('7');
    expect(store.restore()).toBe('7');
  });

  it('treats a corrupt file as no cursor rather than throwing', () => {
    const filePath = join(dir, 'cursor.json');
    const store = createFileCursorStore(filePath);
    store.persist('1');
    // Overwrite with invalid JSON to simulate a corrupt file
    writeFileSync(filePath, 'not json', 'utf8');
    expect(store.restore()).toBeNull();
  });
});
