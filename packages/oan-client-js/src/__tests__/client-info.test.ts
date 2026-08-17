import { describe, it, expect, afterEach } from 'vitest';
import { OanClient } from '../client.js';
import { startFakeOanServer, type FakeOanServer } from './helpers/fake-oan-server.js';

// The connector declares who it is at the handshake (auth.client) so the server can tell it
// when a newer connector release exists; an SDK that omits it stays invisible to that check.

const TOKEN = 'gofers_test_key';

let server: FakeOanServer | undefined;
let client: OanClient | undefined;

afterEach(async () => {
  client?.disconnect();
  client = undefined;
  await server?.close();
  server = undefined;
});

describe('handshake client declaration', () => {
  it('sends the declared connector name and version alongside the token', async () => {
    server = await startFakeOanServer({ expectedToken: TOKEN });
    client = new OanClient({
      baseUrl: server.baseUrl,
      credentials: { apiKey: TOKEN },
      client: { name: '@openagentnetwork/dsh-plugin', version: '0.1.2' },
    });

    await client.connect();

    expect(server.lastHandshakeAuth()).toMatchObject({
      token: TOKEN,
      client: { name: '@openagentnetwork/dsh-plugin', version: '0.1.2' },
    });
  });

  it('omits the declaration entirely when the caller declares nothing', async () => {
    server = await startFakeOanServer({ expectedToken: TOKEN });
    client = new OanClient({ baseUrl: server.baseUrl, credentials: { apiKey: TOKEN } });

    await client.connect();

    const auth = server.lastHandshakeAuth();
    expect(auth).toMatchObject({ token: TOKEN });
    expect(auth && 'client' in auth).toBe(false);
  });
});
