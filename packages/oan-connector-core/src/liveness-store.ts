// Connection liveness file: the process holding the channel connection periodically writes
// its liveness state to disk, where any connector instance can read it.
//
// Rationale (observed in production): tools may execute in an on-demand instance outside the
// process that holds the connection, where the in-process connection object is invisible;
// oan_status could then only answer "not observable from here" — which the agent relays as
// "not connected yet", leaving the user waiting forever on a connection that was in fact
// established long ago. What an in-process registry cannot answer, a file can: the connected
// process refreshes lastAliveAt every write cycle, and a cold instance that reads "alive N
// seconds ago" can give an authoritative answer.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface OanLivenessRecord {
  /** 'connected' is written on connection establishment and each periodic refresh; 'stopped' on terminal stop */
  state: 'connected' | 'stopped';
  baseUrl?: string;
  /** When the connection was last confirmed alive (refreshed at establishment and every write cycle after) */
  lastAliveAt: string;
  connectedAt?: string;
  stoppedReason?: string;
}

/** Write cycle of the connected process; readers treat 2.5x the cycle as "fresh" (surviving one missed write's jitter still counts as alive) */
export const OAN_LIVENESS_WRITE_INTERVAL_MS = 30_000;
export const OAN_LIVENESS_FRESH_MS = Math.round(OAN_LIVENESS_WRITE_INTERVAL_MS * 2.5);

export async function writeLiveness(filePath: string, record: OanLivenessRecord): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(record, null, 2), 'utf8');
}

export async function readLiveness(filePath: string): Promise<OanLivenessRecord | undefined> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as OanLivenessRecord;
    if (parsed && typeof parsed === 'object' && typeof parsed.lastAliveAt === 'string') return parsed;
  } catch {
    // A missing or corrupt file is treated as no record
  }
  return undefined;
}

/** Whether the record is fresh (the connected process was still writing recently = the connection is most likely still alive) */
export function isLivenessFresh(record: OanLivenessRecord, nowMs: number): boolean {
  const at = Date.parse(record.lastAliveAt);
  return Number.isFinite(at) && nowMs - at <= OAN_LIVENESS_FRESH_MS;
}
