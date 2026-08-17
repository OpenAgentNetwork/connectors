// Takeover-pending marker persistence: set on a first connection without a local event cursor
// (fresh install / host switch / lost state), cleared once the takeover digest has been staged
// successfully. A separate small file rather than a field in the cursor file because the
// cursor file is owned exclusively by cursor-store (client-js writes it on every event) and
// the marker's lifecycle is entirely different — mixing them would have the two writers
// clobber each other. The marker is kept when a digest fetch fails and retried on the next
// reconnect — the deterministic-convergence guarantee that first-connection network flakiness
// can never permanently lose owed items.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function markTakeoverPending(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({ pending: true }), 'utf8');
}

export async function isTakeoverPending(filePath: string): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as { pending?: unknown };
    return raw.pending === true;
  } catch {
    // A missing or corrupt file always means "no takeover pending": better to miss one sweep
    // (the owed items remain server-side, and a reinstall or re-pairing can trigger it again)
    // than to let a bad file trigger repeated sweeps forever
    return false;
  }
}

export async function clearTakeoverPending(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({ pending: false }), 'utf8');
}
