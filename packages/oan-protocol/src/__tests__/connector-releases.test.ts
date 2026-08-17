import { describe, it, expect } from 'vitest';
import {
  OAN_CONNECTOR_RELEASES,
  compareConnectorVersions,
  findOutdatedConnector,
  parseClientInfo,
} from '../connector-releases.js';

describe('compareConnectorVersions', () => {
  it('orders release numbers numerically, not lexically', () => {
    expect(compareConnectorVersions('0.1.9', '0.1.10')).toBe(-1);
    expect(compareConnectorVersions('0.1.10', '0.1.9')).toBe(1);
  });

  it('treats equal versions as equal', () => {
    expect(compareConnectorVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('compares major and minor before patch', () => {
    expect(compareConnectorVersions('0.2.0', '0.10.9')).toBe(-1);
    expect(compareConnectorVersions('1.0.0', '0.99.99')).toBe(1);
  });

  it('ignores a prerelease/build suffix rather than guessing its ordering', () => {
    expect(compareConnectorVersions('0.1.2-beta.1', '0.1.2')).toBe(0);
  });

  it('returns undefined for an unparsable version', () => {
    expect(compareConnectorVersions('not-a-version', '0.1.2')).toBeUndefined();
    expect(compareConnectorVersions('0.1.2', '')).toBeUndefined();
  });
});

describe('parseClientInfo', () => {
  it('accepts a well-formed name/version pair', () => {
    expect(parseClientInfo({ name: '@openagentnetwork/dsh-plugin', version: '0.1.2' })).toEqual({
      name: '@openagentnetwork/dsh-plugin',
      version: '0.1.2',
    });
  });

  it('rejects a missing or non-object value', () => {
    expect(parseClientInfo(undefined)).toBeUndefined();
    expect(parseClientInfo('dsh-plugin')).toBeUndefined();
    expect(parseClientInfo({ name: 'x' })).toBeUndefined();
  });

  it('rejects an over-long name or version rather than storing attacker-controlled bulk', () => {
    expect(parseClientInfo({ name: 'a'.repeat(200), version: '0.1.2' })).toBeUndefined();
    expect(parseClientInfo({ name: 'x', version: '0'.repeat(100) })).toBeUndefined();
  });

  it('rejects characters that do not belong in a package name or version', () => {
    expect(parseClientInfo({ name: 'evil<script>', version: '0.1.2' })).toBeUndefined();
    expect(parseClientInfo({ name: 'x', version: '0.1.2 OR 1=1' })).toBeUndefined();
  });
});

describe('findOutdatedConnector', () => {
  const registry = { 'test-connector': { latest: '0.2.0' } };

  it('reports an installed version behind the registry latest', () => {
    expect(findOutdatedConnector({ name: 'test-connector', version: '0.1.9' }, registry)).toEqual({
      name: 'test-connector',
      installed: '0.1.9',
      latest: '0.2.0',
    });
  });

  it('reports nothing when the installed version is current', () => {
    expect(findOutdatedConnector({ name: 'test-connector', version: '0.2.0' }, registry)).toBeUndefined();
  });

  it('reports nothing when the installed version is ahead (local dev build)', () => {
    expect(findOutdatedConnector({ name: 'test-connector', version: '0.3.0' }, registry)).toBeUndefined();
  });

  it('reports nothing for a connector the registry does not know', () => {
    expect(findOutdatedConnector({ name: 'third-party-connector', version: '0.0.1' }, registry)).toBeUndefined();
  });

  it('reports nothing when no client info was declared at all', () => {
    expect(findOutdatedConnector(undefined, registry)).toBeUndefined();
  });

  it('reports nothing when the declared version cannot be parsed', () => {
    expect(findOutdatedConnector({ name: 'test-connector', version: 'latest' }, registry)).toBeUndefined();
  });
});

describe('OAN_CONNECTOR_RELEASES', () => {
  it('carries a parsable latest version for every registered connector', () => {
    const entries = Object.entries(OAN_CONNECTOR_RELEASES);
    expect(entries.length).toBeGreaterThan(0);
    for (const [name, release] of entries) {
      expect(parseClientInfo({ name, version: release.latest })).toBeDefined();
    }
  });
});
