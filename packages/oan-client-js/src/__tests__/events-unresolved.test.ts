import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { listUnresolvedEvents } from '../events.js';
import { OanClient } from '../client.js';
import { OanApiError } from '../errors.js';
import { startFakeOanServer, type FakeOanServer } from './helpers/fake-oan-server.js';

// The SDK fetch function for the takeover-triage endpoint (GET /events/unresolved): correct path/method/auth header, digest passed through untouched.
describe('listUnresolvedEvents', () => {
  const expectedToken = 'gofers_valid-token';
  let server: FakeOanServer;

  beforeEach(async () => {
    server = await startFakeOanServer({ expectedToken });
  });

  afterEach(async () => {
    await server.close();
  });

  it('GET /events/unresolved，带 API Key 鉴权头，返回 digest 原样', async () => {
    const result = await listUnresolvedEvents(server.baseUrl, { kind: 'apiKey', apiKey: expectedToken });

    // Request side: path, method, auth header
    const last = server.lastRequest();
    expect(last?.method).toBe('GET');
    expect(last?.pathname).toBe('/api/v1/events/unresolved');
    expect(last?.headers.authorization).toBe(`Bearer ${expectedToken}`);

    // Response side: the fake server's fixed digest is passed through untouched (events are raw event envelopes, summary is the counts)
    expect(result).toEqual({
      events: [
        {
          v: 1,
          seq: '7',
          eventId: 'evt-unresolved-7',
          type: 'gofer_question',
          goferId: 'g1',
          source: 'own_gofer',
          payload: { messageId: 'm7', content: 'What is the budget?' },
          createdAt: '2026-08-01T00:00:00.000Z',
        },
      ],
      summary: { pendingQuestions: 1, goferCount: 1, decisions: 0 },
    });
  });

  it('无效凭证时抛出带 401 的 OanApiError', async () => {
    await expect(
      listUnresolvedEvents(server.baseUrl, { kind: 'apiKey', apiKey: 'wrong-token' }),
    ).rejects.toMatchObject({ name: 'OanApiError', status: 401 });
    await expect(
      listUnresolvedEvents(server.baseUrl, { kind: 'apiKey', apiKey: 'wrong-token' }),
    ).rejects.toBeInstanceOf(OanApiError);
  });

  it('OanClient.events.listUnresolved() 绑定本实例的 baseUrl 与凭证', async () => {
    const client = new OanClient({
      baseUrl: server.baseUrl,
      credentials: { apiKey: expectedToken },
    });
    const result = await client.events.listUnresolved();
    expect(result.summary).toEqual({ pendingQuestions: 1, goferCount: 1, decisions: 0 });
    expect(result.events.map((e) => e.eventId)).toEqual(['evt-unresolved-7']);
    expect(server.lastRequest()?.pathname).toBe('/api/v1/events/unresolved');
  });
});
