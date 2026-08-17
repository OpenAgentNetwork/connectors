// Inbox store: Gofer messages never go straight into a host session — they land in this
// file-backed inbox first, and a woken turn reads/marks them through the tools. A file rather
// than memory because staging and tool reads may run in different connector processes with no
// shared memory between them; this JSON file is the only reliable shared source of truth.
//
// The file format is a JSON object keyed eventId → item: with the server event id as primary
// key, WS redeliveries of the same event deduplicate naturally; items marked handled are kept
// around for a while (see pruning) so redelivered old events still hit the dedup instead of
// being staged twice.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface OanInboxItem {
  eventId: string;            // Dedup key (server event id; prevents double staging on WS redelivery)
  contactId: string;          // oan:<goferId> or oan:conv:<conversationId>
  kind: 'message' | 'decision' | 'event';
  body: string;
  mediaPaths?: string[];      // Local paths of media files already persisted to disk
  receivedAt: string;         // ISO timestamp
  status: 'pending' | 'handled';
  handledAt?: string;
}

type InboxMap = Record<string, OanInboxItem>;

/** Stage one item; if the eventId already exists (including already-handled) returns 'duplicate' without overwriting */
export async function stageInboxItem(
  filePath: string,
  item: Omit<OanInboxItem, 'status' | 'handledAt'>,
): Promise<'staged' | 'duplicate'> {
  const map = await readMap(filePath);
  // Already-handled items count as duplicates too: the event already completed a full round earlier, and a redelivery must not resurrect it
  if (item.eventId in map) return 'duplicate';
  map[item.eventId] = { ...item, status: 'pending' };
  await writeMap(filePath, map);
  return 'staged';
}

/** List all pending items in receivedAt ascending order */
export async function listPendingInboxItems(filePath: string): Promise<OanInboxItem[]> {
  const map = await readMap(filePath);
  return Object.values(map)
    .filter((item) => item.status === 'pending')
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
}

export async function countPendingInboxItems(filePath: string): Promise<number> {
  const map = await readMap(filePath);
  return Object.values(map).filter((item) => item.status === 'pending').length;
}

/** Batch mark items handled (stamping handledAt); unknown eventIds are silently skipped */
export async function markInboxItemsHandled(filePath: string, eventIds: string[]): Promise<void> {
  const map = await readMap(filePath);
  const handledAt = new Date().toISOString();
  let changed = false;
  for (const eventId of eventIds) {
    const item = map[eventId];
    if (!item || item.status === 'handled') continue;
    map[eventId] = { ...item, status: 'handled', handledAt };
    changed = true;
  }
  if (changed) await writeMap(filePath, map);
}

/**
 * Prune handled items: keep only the most recent (by handledAt) `keep` items (default 50);
 * pending items are never pruned. Recent handled items are retained as the dedup window —
 * redeliveries usually follow the original event closely, and clearing too early would let a
 * redelivery stage twice.
 */
export async function pruneHandledInboxItems(filePath: string, opts?: { keep?: number }): Promise<void> {
  const keep = opts?.keep ?? 50;
  const map = await readMap(filePath);
  const handled = Object.values(map)
    .filter((item) => item.status === 'handled')
    .sort((a, b) => (b.handledAt ?? '').localeCompare(a.handledAt ?? ''));
  if (handled.length <= keep) return;
  for (const item of handled.slice(keep)) {
    delete map[item.eventId];
  }
  await writeMap(filePath, map);
}

async function writeMap(filePath: string, map: InboxMap): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(map, null, 2), 'utf8');
}

async function readMap(filePath: string): Promise<InboxMap> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as InboxMap;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // A missing or corrupt file is treated as an empty map; the next write self-heals
  }
  return {};
}
