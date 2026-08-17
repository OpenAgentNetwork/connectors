// Local persistence for the replay cursor (the seq cursor of GET /events): written to a JSON
// file at a caller-supplied path. This module depends on nothing but that one file-path
// input — it makes no assumptions about any host's storage conventions, which keeps the
// storage medium easy to swap later.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface CursorStore {
  restore(): string | null;
  persist(seq: string): void;
}

export function createFileCursorStore(filePath: string): CursorStore {
  return {
    restore(): string | null {
      if (!existsSync(filePath)) return null;
      try {
        const raw = JSON.parse(readFileSync(filePath, 'utf8')) as { cursor?: unknown };
        return typeof raw.cursor === 'string' ? raw.cursor : null;
      } catch {
        // Corrupt file / invalid JSON: treated as no usable cursor — replaying from the start is safer than breaking the connection
        return null;
      }
    },
    persist(seq: string): void {
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(filePath, JSON.stringify({ cursor: seq }), 'utf8');
    },
  };
}
