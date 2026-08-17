// One-shot advisory markers: for the class of operational advice "worth telling the user
// once, never to be repeated" (first case: platform-disabled heartbeats preventing proactive
// delivery of questions). File persistence guarantees the advice is given once across
// restarts and connector instances; claim semantics = the first call returns true and
// persists, every later call returns false. Failures are silent: read/write errors are
// treated as "never advised" — at worst the advice repeats once, and the main flow is never
// affected.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

type AdvisoryMap = Record<string, string>;

/** Claim an advisory: the first claim returns true (the caller then delivers the advice); already-claimed returns false */
export async function claimAdvisory(filePath: string, key: string): Promise<boolean> {
  let map: AdvisoryMap = {};
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as AdvisoryMap;
    if (parsed && typeof parsed === 'object') map = parsed;
  } catch {
    // A missing or corrupt file is treated as an empty map
  }
  if (map[key]) return false;
  map[key] = new Date().toISOString();
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(map, null, 2), 'utf8');
  } catch {
    // Still return true on a failed write: this advice goes out as planned; it may repeat once next time, which is acceptable
  }
  return true;
}
