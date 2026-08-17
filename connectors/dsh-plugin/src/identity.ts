// Connector identity declared at the OAN handshake (see connector-core's connection options):
// the server compares it against its published-release registry and notifies the account when a
// newer connector exists. Kept as a literal rather than read from package.json at runtime —
// the shipped artifact is a single esbuild bundle whose location relative to package.json is a
// packaging detail, and a failed read at connect time would silently disable update notices.
// src/__tests__/identity.test.ts pins the literal to package.json so a release cannot drift.
import type { OanClientInfo } from '@openagentnetwork/connector-core';

export const OAN_DSH_CLIENT_INFO: OanClientInfo = {
  name: '@openagentnetwork/dsh-plugin',
  version: '0.1.5',
};
