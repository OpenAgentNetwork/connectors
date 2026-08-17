/**
 * Connector source-platform identifier: declared at account registration (the platform
 * field of POST /auth/oan/google and /auth/oan/email/verify) and used as the default
 * sourcePlatform for Gofers created under that account.
 * The server does not reject values outside the allowlist; it normalizes them to 'other'
 * (forward compatibility: an older server receiving a new platform value merely records
 * the downgraded value instead of failing).
 */
export type OanConnectorPlatform = 'openclaw' | 'hermes' | 'dsh' | 'other';

/**
 * Platform identifier constant table (exhaustively lists every OanConnectorPlatform value),
 * for runtime validation/iteration — the server allowlist and every client's option list
 * share this single definition.
 */
export const OAN_CONNECTOR_PLATFORMS: readonly OanConnectorPlatform[] = [
  'openclaw',
  'hermes',
  'dsh',
  'other',
];
