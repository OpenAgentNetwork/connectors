// Minimal test-only OAN server stand-in: a real http server + a real socket.io server (random
// port), not a pure in-memory mock — the SDK's backfill/WS/reconnect logic is only meaningfully
// verified over real network round trips. It implements only the endpoints/handshake rules the
// tests need, with no ambition to cover every detail of the protocol document.
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { OAN_WS_EVENT, OAN_WS_NAMESPACE, type OanEventEnvelope } from '@openagentnetwork/protocol';

export interface FakeOanServerOptions {
  /** Fixed token that handshake/REST auth must match (one simulated account; the tests need no multi-account isolation scenarios) */
  expectedToken: string;
  /**
   * Whether to immediately replay the latest event each time a new socket connects, used to
   * construct the duplicate-delivery scenario where "a backfill page and a live WS push overlap
   * at a reconnect boundary" (protocol document §6 item 4).
   */
  replayLastEventOnConnect?: boolean;
}

export interface FakeOanServer {
  baseUrl: string;
  /** Records one event: adds it to the backfill history (visible via GET /events?since=) and immediately pushes it live to currently connected sockets */
  pushEvent: (partial: Partial<OanEventEnvelope>) => OanEventEnvelope;
  /** Hard-drops every currently connected /oan socket, simulating a network outage (the client runs its own auto-reconnect logic) */
  disconnectAllSockets: () => void;
  /**
   * Closes the underlying engine.io transport without sending a socket.io DISCONNECT packet,
   * simulating a network blip / ping timeout: the client sees reason 'transport close' (as
   * opposed to disconnectAllSockets' 'io server disconnect'), and the built-in engine
   * auto-reconnects the transport and runs another handshake
   */
  crashTransport: () => void;
  /** Cumulative count of handshake-middleware invocations (success or failure), used to assert "is the client still trying to connect" */
  handshakeAttempts: () => number;
  /** The auth payload of the most recent handshake, for asserting what the client declares about itself */
  lastHandshakeAuth: () => Record<string, unknown> | undefined;
  /**
   * Simulates credential revocation (handshake rejection after an API key is invalidated / the
   * account is banned): once called, every new handshake and GET /events request returns 401
   * regardless of whether the token matches
   */
  revokeAuth: () => void;
  /**
   * Suspends GET /events responses in the "request received, response not yet sent" state, to
   * construct the window where "a new event is produced while the backfill request is in
   * flight". The returned function releases all currently suspended responses
   */
  pauseEventsResponses: () => () => void;
  /** Number of GET /events requests that have arrived (started processing, whether or not suspended by pauseEventsResponses) */
  eventsRequestsReceived: () => number;
  /**
   * Metadata of the most recently received request (method/path/headers/body byte count), for
   * the multipart cases to assert that Content-Type carries the fetch-generated boundary and
   * that the body is non-empty — the multipart fields themselves are not parsed (the tests do
   * not care how the server splits parts, only whether the SDK constructed/sent the request correctly)
   */
  lastRequest: () =>
    | { method: string; pathname: string; headers: Record<string, string | undefined>; bodyLength: number; bodyText: string }
    | undefined;
  close: () => Promise<void>;
}

// Starts a fake OAN server on a random port; each test case should start its own instance so they never interfere
export async function startFakeOanServer(options: FakeOanServerOptions): Promise<FakeOanServer> {
  let seq = 0n;
  const events: OanEventEnvelope[] = [];
  let lastEvent: OanEventEnvelope | undefined;
  // Credential revocation switch: simulates the server rejecting every new handshake/REST
  // request after an API key is revoked / the account is banned, regardless of whether the
  // token would otherwise match — in reality revocation lives in server state, independent of what token the client holds
  let authRevoked = false;
  let handshakeAttempts = 0;
  let lastHandshakeAuth: Record<string, unknown> | undefined;
  let eventsRequestsReceived = 0;
  // Suspension gate for GET /events: while non-null, requests are received but their responses
  // hang until the release function returned by pauseEventsResponses() is called
  let eventsGate: Promise<void> | null = null;
  let lastRequest:
    | { method: string; pathname: string; headers: Record<string, string | undefined>; bodyLength: number; bodyText: string }
    | undefined;

  const httpServer = http.createServer((req, res) => {
    void handleRequest(
      req,
      res,
      events,
      options.expectedToken,
      () => authRevoked,
      () => eventsGate,
      () => {
        eventsRequestsReceived += 1;
      },
      (info) => {
        lastRequest = info;
      },
    );
  });

  const io = new SocketIOServer(httpServer);
  const nsp = io.of(OAN_WS_NAMESPACE);
  nsp.use((socket, next) => {
    handshakeAttempts += 1;
    lastHandshakeAuth = socket.handshake.auth as Record<string, unknown> | undefined;
    const token = socket.handshake.auth?.token as string | undefined;
    if (authRevoked || token !== options.expectedToken) {
      next(new Error('unauthorized'));
      return;
    }
    next();
  });
  nsp.on('connection', (socket) => {
    if (options.replayLastEventOnConnect && lastEvent) {
      socket.emit(OAN_WS_EVENT, lastEvent);
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  function pushEvent(partial: Partial<OanEventEnvelope>): OanEventEnvelope {
    seq += 1n;
    const envelope: OanEventEnvelope = {
      v: 1,
      seq: String(seq),
      eventId: `evt-${seq}`,
      type: 'system_notice',
      source: 'platform',
      payload: {},
      createdAt: new Date().toISOString(),
      ...partial,
    };
    events.push(envelope);
    lastEvent = envelope;
    // With no connections this is just a broadcast with no subscribers, equivalent to a no-op — matching the real broadcaster's best-effort push semantics
    nsp.emit(OAN_WS_EVENT, envelope);
    return envelope;
  }

  function disconnectAllSockets(): void {
    for (const socket of nsp.sockets.values()) {
      socket.disconnect(true);
    }
  }

  function crashTransport(): void {
    // Closes the underlying engine.io connection (socket.conn) directly, bypassing socket.io's
    // disconnect-packet path, so the client sees a transport-level close ('transport close')
    // rather than the namespace-level 'io server disconnect'
    for (const socket of nsp.sockets.values()) {
      socket.conn.close();
    }
  }

  function revokeAuth(): void {
    authRevoked = true;
  }

  function pauseEventsResponses(): () => void {
    let release!: () => void;
    eventsGate = new Promise((resolve) => {
      release = resolve;
    });
    return () => {
      release();
      eventsGate = null;
    };
  }

  async function close(): Promise<void> {
    await io.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }

  return {
    baseUrl,
    pushEvent,
    disconnectAllSockets,
    crashTransport,
    handshakeAttempts: () => handshakeAttempts,
    lastHandshakeAuth: () => lastHandshakeAuth,
    revokeAuth,
    pauseEventsResponses,
    eventsRequestsReceived: () => eventsRequestsReceived,
    lastRequest: () => lastRequest,
    close,
  };
}

// Minimal REST routing: covers the GET /events, POST /gofers, DELETE /api-keys/:id the SDK
// tests need, plus the attachment upload / URL redemption endpoints (the multipart fields
// themselves are not parsed — fixed sanitized-shape responses are returned; the tests care
// whether the SDK sent the request correctly, not how the server splits parts)
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  events: OanEventEnvelope[],
  expectedToken: string,
  isAuthRevoked: () => boolean,
  getEventsGate: () => Promise<void> | null,
  onEventsRequestReceived: () => void,
  onRequestReceived: (info: {
    method: string;
    pathname: string;
    headers: Record<string, string | undefined>;
    bodyLength: number;
    bodyText: string;
  }) => void,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks);

  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;

  onRequestReceived({
    method: req.method ?? '',
    pathname: url.pathname,
    headers: {
      'content-type': req.headers['content-type'],
      authorization: authHeader,
    },
    bodyLength: body.length,
    bodyText: body.toString('utf8'),
  });

  const send = (status: number, respBody?: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(respBody === undefined ? '' : JSON.stringify(respBody));
  };

  if (url.pathname === '/api/v1/events/cursor' && req.method === 'GET') {
    if (isAuthRevoked() || token !== expectedToken) return send(401, { error: '无效凭证', code: 'UNAUTHORIZED' });
    // Matches the real server: returns this account's current max seq ("0" when there are no events)
    const maxSeq = events.reduce((max, e) => (BigInt(e.seq) > max ? BigInt(e.seq) : max), 0n);
    return send(200, { seq: maxSeq.toString() });
  }

  if (url.pathname === '/api/v1/events/unresolved' && req.method === 'GET') {
    if (isAuthRevoked() || token !== expectedToken) return send(401, { error: '无效凭证', code: 'UNAUTHORIZED' });
    // Fixed-shape takeover-triage response: the tests only care that the SDK sends the request
    // correctly and passes the digest through untouched; computing real unresolved state is the server tests' responsibility
    return send(200, {
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
  }

  if (url.pathname === '/api/v1/events' && req.method === 'GET') {
    onEventsRequestReceived();
    if (isAuthRevoked() || token !== expectedToken) return send(401, { error: '无效凭证', code: 'UNAUTHORIZED' });
    // Suspension gate: the request has arrived (letting tests confirm "the backfill request is in flight"), but the response only happens after release()
    const gate = getEventsGate();
    if (gate) await gate;
    const since = BigInt(url.searchParams.get('since') ?? '0');
    const limit = Number(url.searchParams.get('limit') ?? '50');
    const page = events.filter((e) => BigInt(e.seq) > since).slice(0, limit);
    return send(200, page);
  }

  if (url.pathname === '/api/v1/gofers' && req.method === 'POST') {
    if (token !== expectedToken) return send(401, { error: '无效凭证', code: 'UNAUTHORIZED' });
    return send(201, { goferId: 'g1', chatId: 'c1', greeting: '你好' });
  }

  if (/^\/api\/v1\/api-keys\/.+/.test(url.pathname) && req.method === 'DELETE') {
    if (token !== expectedToken) return send(401, { error: '无效凭证', code: 'UNAUTHORIZED' });
    if (url.pathname.endsWith('/not-mine')) return send(403, { error: '无权操作该 API Key', code: 'FORBIDDEN' });
    return send(204);
  }

  if (/^\/api\/v1\/gofers\/[^/]+\/chat\/messages$/.test(url.pathname) && req.method === 'POST') {
    if (token !== expectedToken) return send(401, { error: '无效凭证', code: 'UNAUTHORIZED' });
    return send(202, { accepted: true });
  }

  if (/^\/api\/v1\/conversations\/[^/]+\/messages$/.test(url.pathname) && req.method === 'POST') {
    if (token !== expectedToken) return send(401, { error: '无效凭证', code: 'UNAUTHORIZED' });
    return send(201, {
      id: 'msg-1',
      senderUserId: 'u1',
      content: '',
      attachments: [],
      changeSequence: '1',
      createdAt: new Date().toISOString(),
    });
  }

  if (/^\/api\/v1\/gofers\/[^/]+\/attachments$/.test(url.pathname) && req.method === 'POST') {
    if (token !== expectedToken) return send(401, { error: '无效凭证', code: 'UNAUTHORIZED' });
    return send(201, {
      attachment: { id: 'att-1', name: 'doc.pdf', url: 'storage-key-1', mimeType: 'application/pdf', size: body.length, ragStatus: 'processing' },
      ragStatus: 'processing',
    });
  }

  if (/^\/api\/v1\/gofers\/[^/]+\/photos$/.test(url.pathname) && req.method === 'POST') {
    if (token !== expectedToken) return send(401, { error: '无效凭证', code: 'UNAUTHORIZED' });
    return send(201, { photo: { id: 'photo-1', name: 'pic.png', mimeType: 'image/png', size: body.length, width: 100, height: 200 } });
  }

  if (/^\/api\/v1\/conversations\/[^/]+\/attachments$/.test(url.pathname) && req.method === 'POST') {
    if (token !== expectedToken) return send(401, { error: '无效凭证', code: 'UNAUTHORIZED' });
    return send(201, {
      attachment: {
        attachmentId: 'conv-att-1',
        kind: url.searchParams.get('kind') ?? 'photo',
        name: 'pic.png',
        mimeType: 'image/png',
        size: body.length,
        width: 10,
        height: 20,
      },
    });
  }

  if (/^\/api\/v1\/conversations\/[^/]+\/attachments\/[^/]+\/url$/.test(url.pathname) && req.method === 'GET') {
    if (token !== expectedToken) return send(401, { error: '无效凭证', code: 'UNAUTHORIZED' });
    if (url.pathname.endsWith('/missing-attachment/url')) return send(404, { error: '附件不存在', code: 'NOT_FOUND' });
    return send(200, { url: 'https://signed.example.com/conversation-attachment' });
  }

  if (/^\/api\/v1\/threads\/[^/]+\/counterpart-attachments\/[^/]+\/url$/.test(url.pathname) && req.method === 'GET') {
    if (token !== expectedToken) return send(401, { error: '无效凭证', code: 'UNAUTHORIZED' });
    if (url.pathname.endsWith('/missing-attachment/url')) return send(404, { error: '附件不存在', code: 'NOT_FOUND' });
    return send(200, { url: 'https://signed.example.com/counterpart-attachment', expiresAt: 1893456000000 });
  }

  send(404, { error: 'not found', code: 'NOT_FOUND' });
}
