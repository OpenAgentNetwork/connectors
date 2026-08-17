// State directory resolution: replicates the host's resolveDshHome() logic
// (verbatim from the harness's packages/util/home-paths/src/index.ts:61-91) without
// importing any host runtime module.
// Three details that must survive: explicit config > $DSH_HOME (counts as set only when
// non-empty after trim) > ~/.dsh; the ~ / ~/ / ~\ expansions; a final resolve(). All OAN
// state files live under <dshHome>/oan/ as self-managed JSON (the base bundle has no
// ctx.storage backend, §8.3 — never inject storage).
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** The full set of OAN state file paths (single-account shape: file names carry no account suffix) */
export interface OanStatePaths {
  stateDir: string;
  /** Inbox (inbox-store): the single landing place for Gofer messages; the read surface of oan_inbox */
  inboxPath: string;
  /** Event replay cursor (cursor-store, written by client-js per event) */
  cursorPath: string;
  /** Takeover-pending flag (takeover-store): set on a cursorless first connection, cleared after a successful sweep */
  takeoverPath: string;
  /** Pending-exchange ledger (pending-ledger): the durable fact of "who is still owed a reply" */
  ledgerPath: string;
  /** Wake coalescing record (pending-wake-store): the basis for sending one followup for a burst of N items */
  wakePath: string;
  /** One-shot advisory flags (advisory-store) */
  advisoryPath: string;
  /** Single-machine two-instance lock (pid + heartbeat) */
  lockPath: string;
  /** Directory where inbound attachments land */
  mediaDir: string;
}

export function oanStatePaths(env: Record<string, string | undefined> = process.env): OanStatePaths {
  const stateDir = oanStateDir(env);
  return {
    stateDir,
    inboxPath: join(stateDir, 'inbox.json'),
    cursorPath: join(stateDir, 'cursor.json'),
    takeoverPath: join(stateDir, 'takeover.json'),
    ledgerPath: join(stateDir, 'ledger.json'),
    wakePath: join(stateDir, 'wake.json'),
    advisoryPath: join(stateDir, 'advisory.json'),
    lockPath: join(stateDir, 'lock.json'),
    mediaDir: join(stateDir, 'media'),
  };
}

/** The OAN-specific state directory: <dshHome>/oan/ */
export function oanStateDir(env: Record<string, string | undefined> = process.env): string {
  return join(resolveDshHome(undefined, env), 'oan');
}

/**
 * Host home directory resolution (a verbatim replica of home-paths/src/index.ts:75-91):
 * explicit config > $DSH_HOME (empty/whitespace-only counts as unset, so an empty override
 * can never resolve home to the cwd) > ~/.dsh.
 */
export function resolveDshHome(
  configured?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const fromEnv = env['DSH_HOME'];
  const selected = configured ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : defaultDshHome());
  return resolve(expandHomePath(selected));
}

/** ~ prefix expansion (verbatim from home-paths/src/index.ts:66-70): the ~ / ~/ / ~\ forms */
export function expandHomePath(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2));
  return path;
}

/** Default host home: ~/.dsh (home-paths/src/index.ts:61-63) */
function defaultDshHome(): string {
  return join(homedir(), '.dsh');
}
