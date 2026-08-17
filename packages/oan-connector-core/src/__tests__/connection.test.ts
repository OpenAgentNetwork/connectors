import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OanEventEnvelope } from '@openagentnetwork/client-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (envelope: OanEventEnvelope) => void;

// Verify OanConnection's wiring with a controllable fake OanClient: event → pendingReplies
// record → deliverInbound callback; the replay/reconnect logic of @openagentnetwork/client-js
// itself is not re-tested here (that is its own test scope).
const clientInstances: Array<{
  options: Record<string, unknown>;
  emit: (envelope: OanEventEnvelope) => void;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}> = [];

vi.mock('@openagentnetwork/client-js', () => {
  class FakeOanClient {
    private listener: Listener | undefined;
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn();
    gofers = {};
    matchRequests = {};
    conversations = {};

    constructor(public options: Record<string, unknown>) {
      clientInstances.push({
        options,
        emit: (envelope) => this.listener?.(envelope),
        connect: this.connect,
        disconnect: this.disconnect,
      });
    }

    onEvent(cb: Listener): () => void {
      this.listener = cb;
      return () => {
        this.listener = undefined;
      };
    }
  }
  return { OanClient: FakeOanClient };
});

function envelope(overrides: Partial<OanEventEnvelope>): OanEventEnvelope {
  return {
    v: 1,
    seq: '5',
    eventId: 'evt-5',
    type: 'gofer_message',
    source: 'own_gofer',
    goferId: 'g1',
    payload: { content: 'hi' },
    createdAt: '2026-07-10T00:00:00.000Z',
    ...overrides,
  };
}

describe('OanConnection', () => {
  let dir: string;

  beforeEach(() => {
    clientInstances.length = 0;
    dir = mkdtempSync(join(tmpdir(), 'oan-core-connection-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('maps inbound events to InboundMessageDraft, records pending replies, and delivers them', async () => {
    const { OanConnection } = await import('../connection.js');
    const deliverInbound = vi.fn();

    const connection = new OanConnection({
      baseUrl: 'https://api.example.com',
      apiKey: 'test-api-key',
      stateFilePath: join(dir, 'cursor.json'),
      deliverInbound,
    });

    await connection.connect();

    const fakeClient = clientInstances[0];
    expect(fakeClient.connect).toHaveBeenCalled();

    // Receiver sovereignty: the envelope carries no "must consult" flag; consulting or not is the agent's own triage
    fakeClient.emit(
      envelope({ type: 'gofer_question', reply: { method: 'POST', path: '/x' } }),
    );

    expect(deliverInbound).toHaveBeenCalledTimes(1);
    const draft = deliverInbound.mock.calls[0][0];
    expect(draft.contactId).toBe('oan:g1');
    expect(draft.kind).toBe('question');
    expect(draft.expectsReply).toBe(true);
    expect(connection.pendingReplies.peek('oan:g1')).toBeDefined();
  });

  it('wires restoreCursor/persistCursor to a file-backed cursor store', async () => {
    const { OanConnection } = await import('../connection.js');
    const stateFilePath = join(dir, 'cursor.json');

    new OanConnection({
      baseUrl: 'https://api.example.com',
      apiKey: 'test-api-key',
      stateFilePath,
      deliverInbound: vi.fn(),
    });

    const options = clientInstances[0].options as {
      restoreCursor: () => string | null;
      persistCursor: (seq: string) => void;
    };

    expect(options.restoreCursor()).toBeNull();
    options.persistCursor('42');
    expect(options.restoreCursor()).toBe('42');
  });

  it('passes the adapter\'s connector identity to the SDK so the handshake declares it', async () => {
    const { OanConnection } = await import('../connection.js');

    new OanConnection({
      baseUrl: 'https://api.example.com',
      apiKey: 'test-api-key',
      stateFilePath: join(dir, 'cursor.json'),
      deliverInbound: vi.fn(),
      client: { name: '@openagentnetwork/dsh-plugin', version: '0.1.2' },
    });

    expect(clientInstances[0].options.client).toEqual({
      name: '@openagentnetwork/dsh-plugin',
      version: '0.1.2',
    });
  });

  it('declares nothing when the adapter supplied no connector identity', async () => {
    const { OanConnection } = await import('../connection.js');

    new OanConnection({
      baseUrl: 'https://api.example.com',
      apiKey: 'test-api-key',
      stateFilePath: join(dir, 'cursor.json'),
      deliverInbound: vi.fn(),
    });

    expect(clientInstances[0].options.client).toBeUndefined();
  });

  it('exposes baseUrl/authMode for the pair-confirm gap-fill helper', async () => {
    const { OanConnection } = await import('../connection.js');
    const connection = new OanConnection({
      baseUrl: 'https://api.example.com',
      apiKey: 'test-api-key',
      stateFilePath: join(dir, 'cursor.json'),
      deliverInbound: vi.fn(),
    });

    expect(connection.baseUrl).toBe('https://api.example.com');
    expect(connection.authMode).toEqual({ kind: 'apiKey', apiKey: 'test-api-key' });
  });
});

describe('statusSnapshot', () => {
  it('tracks connect, event flow, and terminal stop', async () => {
    const statusDir = mkdtempSync(join(tmpdir(), 'oan-core-status-'));
    const deliverInbound = vi.fn();
    const onStopped = vi.fn();
    const { OanConnection } = await import('../connection.js');
    const connection = new OanConnection({
      baseUrl: 'https://api.example',
      apiKey: 'test-key-k',
      stateFilePath: join(statusDir, 'status-state.json'),
      deliverInbound,
      onStopped,
    });
    const fake = clientInstances[clientInstances.length - 1];

    expect(connection.statusSnapshot()).toMatchObject({ connected: false, eventCount: 0 });

    await connection.connect();
    expect(connection.statusSnapshot()).toMatchObject({ connected: true });

    fake.emit(envelope({ eventId: 'evt-a' }));
    const afterEvent = connection.statusSnapshot();
    expect(afterEvent.eventCount).toBe(1);
    expect(afterEvent.lastEventAt).toBeTruthy();

    // Terminal stop: the wrapper records the reason and passes it through to the caller's original callback
    (fake.options.onStopped as (reason: string) => void)('auth-rejected');
    expect(connection.statusSnapshot()).toMatchObject({ connected: false, stoppedReason: 'auth-rejected' });
    expect(onStopped).toHaveBeenCalledWith('auth-rejected');
    rmSync(statusDir, { recursive: true, force: true });
  });
});
