// Cross-instance retry queue for targeted main-session wakes: when an oan_ask_user wake has
// been queued but the host skipped the wake turn (e.g. because other requests were in
// flight), the connector's resident process retries the wake periodically — with no reliance
// on host scheduling facilities that may be unavailable — until the user sees the queued
// question or the session ends.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface PendingMainWake {
  contactId: string;
  question: string;
  mainSessionKey: string;
  agentId?: string;
  queuedAt: string;
  lastAttemptAt?: string;
  attemptCount: number;
}

type PendingWakeMap = Record<string, PendingMainWake>;

/** Register a main-session wake for retry (later writes for the same contact overwrite) */
export async function stagePendingMainWake(
  filePath: string,
  entry: Omit<PendingMainWake, 'queuedAt' | 'attemptCount'> & { queuedAt?: string; attemptCount?: number },
): Promise<void> {
  const map = await readMap(filePath);
  map[entry.contactId] = {
    contactId: entry.contactId,
    question: entry.question,
    mainSessionKey: entry.mainSessionKey,
    ...(entry.agentId ? { agentId: entry.agentId } : {}),
    queuedAt: entry.queuedAt ?? new Date().toISOString(),
    attemptCount: entry.attemptCount ?? 0,
    ...(entry.lastAttemptAt ? { lastAttemptAt: entry.lastAttemptAt } : {}),
  };
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(map, null, 2), 'utf8');
}

export async function listPendingMainWakes(filePath: string): Promise<PendingMainWake[]> {
  return Object.values(await readMap(filePath));
}

export async function touchPendingMainWakeAttempt(filePath: string, contactId: string): Promise<void> {
  const map = await readMap(filePath);
  const entry = map[contactId];
  if (!entry) return;
  map[contactId] = {
    ...entry,
    attemptCount: entry.attemptCount + 1,
    lastAttemptAt: new Date().toISOString(),
  };
  await writeFile(filePath, JSON.stringify(map, null, 2), 'utf8');
}

export async function removePendingMainWake(filePath: string, contactId: string): Promise<void> {
  const map = await readMap(filePath);
  if (!(contactId in map)) return;
  delete map[contactId];
  try {
    await writeFile(filePath, JSON.stringify(map, null, 2), 'utf8');
  } catch {
    // A failed delete at worst repeats the wake once next round; event dedup absorbs it
  }
}

async function readMap(filePath: string): Promise<PendingWakeMap> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as PendingWakeMap;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // A missing or corrupt file is treated as an empty map
  }
  return {};
}
