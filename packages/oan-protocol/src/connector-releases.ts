/**
 * Connector release registry and version-declaration types.
 *
 * A connector declares who it is at the WebSocket handshake (`auth.client`); the server
 * compares that declaration against the registry below and, when the connector is behind,
 * sends the account a one-off `connector_outdated` system notice. Without this, an installed
 * connector stays on whatever version it was installed at forever — package managers pin it
 * in a lockfile, and nothing on the network would otherwise tell the agent a newer one exists.
 *
 * The declaration is client-supplied and therefore untrusted: parseClientInfo() bounds it
 * before anything is stored or echoed back into an event payload.
 */

/** Who the connecting connector says it is; declared in the handshake auth payload */
export interface OanClientInfo {
  /** Connector package name, e.g. '@openagentnetwork/dsh-plugin' */
  name: string;
  /** Installed connector version, e.g. '0.1.2' */
  version: string;
}

/** What the platform currently publishes for one connector */
export interface OanConnectorRelease {
  /** Newest version published to the connector's distribution channel */
  latest: string;
}

/** A connector found to be behind its published release */
export interface OanOutdatedConnector {
  name: string;
  installed: string;
  latest: string;
}

/**
 * Published connector versions, keyed by the name the connector declares.
 *
 * **Bump an entry as part of publishing that connector** — the registry is what turns a
 * publish into a notice for every account still running the old build. A connector missing
 * from this table (a third-party one, say) is simply never nagged.
 */
export const OAN_CONNECTOR_RELEASES: Readonly<Record<string, OanConnectorRelease>> = {
  '@openagentnetwork/dsh-plugin': { latest: '0.1.5' },
  '@openagentnetwork/openclaw-plugin': { latest: '0.2.8' },
};

/** Package-name charset: npm scoped/unscoped names only */
const NAME_PATTERN = /^[@A-Za-z0-9._/-]+$/;
/** Version charset: semver digits, dots, and prerelease/build punctuation */
const VERSION_PATTERN = /^[A-Za-z0-9.+-]+$/;
const MAX_NAME_LENGTH = 128;
const MAX_VERSION_LENGTH = 64;

/** Leading `major.minor.patch`; any prerelease/build suffix is deliberately ignored (see compareConnectorVersions) */
const RELEASE_NUMBER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

/**
 * Validate an untrusted handshake `auth.client` value into an OanClientInfo.
 * Returns undefined for anything malformed, over-long, or outside the expected charset —
 * the value ends up persisted in an event payload, so it is bounded before it is trusted.
 */
export function parseClientInfo(raw: unknown): OanClientInfo | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { name, version } = raw as { name?: unknown; version?: unknown };
  if (typeof name !== 'string' || typeof version !== 'string') return undefined;
  if (!name || name.length > MAX_NAME_LENGTH || !NAME_PATTERN.test(name)) return undefined;
  if (!version || version.length > MAX_VERSION_LENGTH || !VERSION_PATTERN.test(version)) return undefined;
  return { name, version };
}

/**
 * Compare two connector versions by their release numbers: -1 / 0 / 1, or undefined when
 * either side has no parsable `major.minor.patch`.
 *
 * A prerelease or build suffix is ignored rather than ordered: the registry only ever holds
 * published releases, so the one case that matters — is this install behind the published
 * build — is decided by the release numbers alone, and treating `0.1.2-beta.1` as equal to
 * `0.1.2` keeps a pre-release tester from being nagged to "update" to what they already run.
 */
export function compareConnectorVersions(a: string, b: string): number | undefined {
  const left = parseReleaseNumber(a);
  const right = parseReleaseNumber(b);
  if (!left || !right) return undefined;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i]! !== right[i]!) return left[i]! < right[i]! ? -1 : 1;
  }
  return 0;
}

/**
 * Decide whether a connecting connector is behind its published release.
 * Returns undefined — meaning "say nothing" — for an undeclared, unknown, unparsable, or
 * already-current connector, and for an install running ahead of the registry (a local build).
 */
export function findOutdatedConnector(
  info: OanClientInfo | undefined,
  registry: Readonly<Record<string, OanConnectorRelease>> = OAN_CONNECTOR_RELEASES,
): OanOutdatedConnector | undefined {
  if (!info) return undefined;
  const release = registry[info.name];
  if (!release) return undefined;
  const order = compareConnectorVersions(info.version, release.latest);
  if (order === undefined || order >= 0) return undefined;
  return { name: info.name, installed: info.version, latest: release.latest };
}

/** Split `major.minor.patch` into numbers; undefined when the shape does not match */
function parseReleaseNumber(version: string): [number, number, number] | undefined {
  const matched = RELEASE_NUMBER_PATTERN.exec(version.trim());
  if (!matched) return undefined;
  return [Number(matched[1]), Number(matched[2]), Number(matched[3])];
}
