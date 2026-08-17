// The connector declares its own name and version at the OAN handshake so the server can tell
// the account when a newer release exists. That declaration is only as good as its accuracy:
// a constant left behind at release time would report a stale version forever, and the account
// would either be nagged after updating or never nagged at all. package.json is the single
// source of truth for the version — this test is what keeps the constant tied to it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OAN_CONNECTOR_RELEASES } from '@openagentnetwork/connector-core';
import { OAN_DSH_CLIENT_INFO } from '../identity.js';

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf-8'),
) as { name: string; version: string };

describe('OAN_DSH_CLIENT_INFO', () => {
  it('declares the published package name', () => {
    expect(OAN_DSH_CLIENT_INFO.name).toBe(packageJson.name);
  });

  it('declares the version in package.json (a stale constant would misreport this install)', () => {
    expect(OAN_DSH_CLIENT_INFO.version).toBe(packageJson.version);
  });

  it('declares a name the server\'s release registry knows (an unknown name is never notified)', () => {
    expect(Object.keys(OAN_CONNECTOR_RELEASES)).toContain(OAN_DSH_CLIENT_INFO.name);
  });

  // Release invariant: a version bump that forgets the registry leaves every installed copy
  // silently un-notified forever — the failure is invisible in production, so it is caught here.
  it('is the version the release registry publishes as latest', () => {
    expect(OAN_CONNECTOR_RELEASES[OAN_DSH_CLIENT_INFO.name]?.latest).toBe(OAN_DSH_CLIENT_INFO.version);
  });
});
