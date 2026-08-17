import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OanEventEnvelope } from '@openagentnetwork/protocol';
import { OanClient } from '../client.js';
import { startFakeOanServer, type FakeOanServer } from './helpers/fake-oan-server.js';

// Lossless, duplicate-free backfill across disconnect/reconnect is this SDK's core use case:
// covers the initial history catch-up, no event loss while offline, no duplicates when backfill
// and WS overlap, cursor-persistence callback timing, restoreCursor resumption, and the paging loop.
describe('OanClient 连接/重连/补发', () => {
  const expectedToken = 'gofers_valid-token';
  let server: FakeOanServer;

  // Reconnect-related tests need a faster socket.io reconnect cadence, or the tests get dragged out by the default 1s backoff
  const fastSocketOptions = {
    reconnectionDelay: 20,
    reconnectionDelayMax: 50,
    reconnectionAttempts: Infinity,
    timeout: 2000,
  };

  beforeEach(async () => {
    server = await startFakeOanServer({ expectedToken });
  });

  afterEach(async () => {
    await server.close();
  });

  function makeClient(overrides: Partial<ConstructorParameters<typeof OanClient>[0]> = {}) {
    const received: OanEventEnvelope[] = [];
    const persistedSeqs: string[] = [];
    const client = new OanClient({
      baseUrl: server.baseUrl,
      credentials: { apiKey: expectedToken },
      // Most cases exercise the backfill/merge machinery itself, so they explicitly start from 0
      // (restoreCursor returning '0' = the caller deliberately requests full history); the
      // "brand-new connector" semantics (no cursor → start from the current cursor) has its own dedicated case
      restoreCursor: () => '0',
      persistCursor: (seq) => {
        persistedSeqs.push(seq);
      },
      socketOptions: fastSocketOptions,
      ...overrides,
    });
    client.onEvent((envelope) => received.push(envelope));
    return { client, received, persistedSeqs };
  }

  it('全新连接器（无本地游标）从当前游标起步：不回放历史，游标被初始化并持久化', async () => {
    server.pushEvent({ payload: { index: 0 } });
    server.pushEvent({ payload: { index: 1 } });

    const { client, received, persistedSeqs } = makeClient({ restoreCursor: undefined });
    await client.connect();

    // Not a single history event is delivered
    expect(received).toHaveLength(0);
    // The cursor was initialized to the server's current max seq and persisted (subsequent reconnects backfill only genuinely new events)
    expect(persistedSeqs).toContain('2');

    // New events produced after connecting still arrive live as usual
    server.pushEvent({ payload: { index: 2 } });
    await vi.waitFor(() => {
      expect(received.map((e) => e.seq)).toEqual(['3']);
    });
    client.disconnect();
  });

  it('显式 restoreCursor 返回 0 时补齐已存在的历史事件，并按 seq 升序投递', async () => {
    server.pushEvent({ payload: { index: 0 } });
    server.pushEvent({ payload: { index: 1 } });

    const { client, received } = makeClient();
    await client.connect();

    expect(received).toHaveLength(2);
    expect(received.map((e) => e.seq)).toEqual(['1', '2']);
    client.disconnect();
  });

  it('游标持久化回调应随每个事件推进依次调用，而不是只在最后调用一次', async () => {
    server.pushEvent({ payload: { index: 0 } });
    server.pushEvent({ payload: { index: 1 } });

    const { client, persistedSeqs } = makeClient();
    await client.connect();

    expect(persistedSeqs).toEqual(['1', '2']);
    client.disconnect();
  });

  it('restoreCursor 返回的游标应被尊重，只补发严格更大的 seq', async () => {
    for (let i = 0; i < 5; i += 1) {
      server.pushEvent({ payload: { index: i } });
    }

    const { client, received } = makeClient({ restoreCursor: () => '3' });
    await client.connect();

    expect(received.map((e) => e.seq)).toEqual(['4', '5']);
    client.disconnect();
  });

  it('单页 limit 小于事件总数时应分页循环拉完，而不是只拿第一页', async () => {
    for (let i = 0; i < 5; i += 1) {
      server.pushEvent({ payload: { index: i } });
    }

    const { client, received } = makeClient({ backfillPageLimit: 2 });
    await client.connect();

    expect(received).toHaveLength(5);
    expect(received.map((e) => e.seq)).toEqual(['1', '2', '3', '4', '5']);
    client.disconnect();
  });

  it('断线期间产生的事件，重连后应通过补发无缺漏地收到，且不与在线时收到的事件重复', async () => {
    const { client, received } = makeClient();
    await client.connect();

    // Receive one live event while online first
    server.pushEvent({ payload: { phase: 'online' } });
    await vi.waitFor(() => expect(received).toHaveLength(1));

    // Simulate a network outage: the server hard-drops the current socket and the client auto-reconnects (fastSocketOptions has sped up the backoff)
    server.disconnectAllSockets();

    // Two events produced while offline: no socket is connected at this point, so the live push is a no-op and they land only in the backfill history
    server.pushEvent({ payload: { phase: 'offline-1' } });
    server.pushEvent({ payload: { phase: 'offline-2' } });

    // After reconnecting, the client should pick both up automatically via backfill — 3 events total, ascending by seq, with no gaps and no duplicates
    await vi.waitFor(() => expect(received).toHaveLength(3), { timeout: 5000, interval: 20 });
    expect(received.map((e) => e.seq)).toEqual(['1', '2', '3']);
    expect(new Set(received.map((e) => e.eventId)).size).toBe(3);

    client.disconnect();
  });

  it('补发页与重连后 WS 实时重放重叠时，同一事件只投递一次（按 seq 去重）', async () => {
    // Spin up a dedicated server instance with "replay the latest event on every reconnect" enabled, constructing a genuine overlap between the backfill and WS paths
    const replayServer = await startFakeOanServer({ expectedToken, replayLastEventOnConnect: true });
    try {
      const received: OanEventEnvelope[] = [];
      const client = new OanClient({
        baseUrl: replayServer.baseUrl,
        credentials: { apiKey: expectedToken },
        socketOptions: fastSocketOptions,
      });
      client.onEvent((envelope) => received.push(envelope));

      await client.connect();
      replayServer.pushEvent({ payload: { index: 0 } });
      replayServer.pushEvent({ payload: { index: 1 } });
      await vi.waitFor(() => expect(received).toHaveLength(2));

      // Produce one more event (seq=3) at the instant of disconnection: on reconnect it gets
      // replayed once by the server's 'connection' hook AND fetched once by the client's own
      // backfill (GET /events?since=2) — exactly the "backfill/WS overlap" scenario described in
      // protocol document §6 item 4; dedup must guarantee it is ultimately delivered only once
      replayServer.disconnectAllSockets();
      replayServer.pushEvent({ payload: { index: 2 } });

      await vi.waitFor(() => expect(received.some((e) => e.seq === '3')).toBe(true), {
        timeout: 5000,
        interval: 20,
      });
      // Leave a time window for the second, overlapping delivery path, to confirm no extra duplicates appear
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(received.filter((e) => e.seq === '3')).toHaveLength(1);
      expect(received.map((e) => e.seq)).toEqual(['1', '2', '3']);

      client.disconnect();
    } finally {
      await replayServer.close();
    }
  });

  it('未知事件类型/协议版本不一致：仍然投递给 onEvent，但触发 onProtocolWarning', async () => {
    server.pushEvent({ type: 'future_event_type' as never, payload: {} });
    server.pushEvent({ v: 2, payload: {} });

    const warnings: Array<{ kind: string }> = [];
    const { client, received } = makeClient({
      onProtocolWarning: (w) => warnings.push(w),
    });
    await client.connect();

    expect(received).toHaveLength(2);
    expect(warnings.map((w) => w.kind).sort()).toEqual(['unknown_event_type', 'version_mismatch']);
    client.disconnect();
  });

  it('首连期间（backfill 请求已发出、还未回包）产生的新事件不应丢失：WS 应先于补发建立', async () => {
    // Empty history: the first backfill page waits behind this gate; the WS must already be connected at this point for no event to be lost
    const release = server.pauseEventsResponses();

    const { client, received } = makeClient();
    const connectPromise = client.connect();

    // Wait until the backfill request has actually reached the server (proving the WS was established earlier and the backfill is in flight), then produce a new event
    await vi.waitFor(() => expect(server.eventsRequestsReceived()).toBeGreaterThan(0));
    const pushed = server.pushEvent({ payload: { phase: 'during-first-backfill' } });

    release();
    await connectPromise;

    expect(received.map((e) => e.eventId)).toEqual([pushed.eventId]);
    expect(received).toHaveLength(1);
    client.disconnect();
  });

  it('disconnect() 后再次 connect() 应恢复 WS 事件投递，而不是静默失效', async () => {
    const { client, received } = makeClient();
    await client.connect();

    server.pushEvent({ payload: { phase: 'before-disconnect' } });
    await vi.waitFor(() => expect(received).toHaveLength(1));

    client.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // An event produced while disconnected: no active connection exists now, so the next connect()'s backfill picks it back up
    server.pushEvent({ payload: { phase: 'while-disconnected' } });

    await client.connect();

    // After reconnecting, the WS must genuinely resume delivery (not be misjudged as "already connected" by openSocket because this.socket still points at the old socket)
    server.pushEvent({ payload: { phase: 'after-reconnect' } });
    await vi.waitFor(() => expect(received).toHaveLength(3));
    expect(received.map((e) => e.payload)).toEqual([
      { phase: 'before-disconnect' },
      { phase: 'while-disconnected' },
      { phase: 'after-reconnect' },
    ]);

    client.disconnect();
  });

  it('persistCursor 某次调用失败不应让后续事件的分发管道永久卡死', async () => {
    server.pushEvent({ payload: { index: 0 } });
    server.pushEvent({ payload: { index: 1 } });
    server.pushEvent({ payload: { index: 2 } });
    server.pushEvent({ payload: { index: 3 } });

    const persistedSeqs: string[] = [];
    const errors: unknown[] = [];
    let callCount = 0;
    const { client, received } = makeClient({
      persistCursor: (seq) => {
        callCount += 1;
        if (callCount === 2) {
          return Promise.reject(new Error('落盘失败（模拟磁盘/数据库瞬时故障）'));
        }
        persistedSeqs.push(seq);
      },
      onError: (error) => errors.push(error),
    });

    await client.connect();

    // All four events are delivered and the cursor advances through all of them, even though the 2nd persistCursor call failed
    expect(received.map((e) => e.seq)).toEqual(['1', '2', '3', '4']);
    // The 2nd call failed and was not recorded into persistedSeqs, but the 3rd/4th calls still happened normally
    expect(persistedSeqs).toEqual(['1', '3', '4']);
    expect(errors).toHaveLength(1);
    client.disconnect();
  });

  it('收到账户封禁的 system_notice 后应主动停止，不再发起任何新连接', async () => {
    const stopped: string[] = [];
    const errors: unknown[] = [];
    const { client, received } = makeClient({
      onStopped: (reason) => stopped.push(reason),
      onError: (error) => errors.push(error),
    });
    await client.connect();
    const handshakesAfterConnect = server.handshakeAttempts();

    server.pushEvent({ type: 'system_notice', payload: { kind: 'account_banned' } });
    await vi.waitFor(() => expect(stopped).toEqual(['account_banned']));
    expect(errors).toHaveLength(1);
    // The notice itself is still delivered to the business layer as usual; stopping is additional behavior, not a substitute for delivery
    expect(received.some((e) => e.type === 'system_notice')).toBe(true);

    // Simulate the hard drop that immediately follows in the server's ban-enforcement flow
    server.disconnectAllSockets();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(server.handshakeAttempts()).toBe(handshakesAfterConnect); // no new handshake attempts were initiated
  });

  it('连续握手失败达到 reconnectionAttempts 上限后应停止，不再无限重连', async () => {
    const stopped: string[] = [];
    const errors: unknown[] = [];
    const { client } = makeClient({
      reconnectionAttempts: 3,
      onStopped: (reason) => stopped.push(reason),
      onError: (error) => errors.push(error),
      // The built-in reconnection engine itself gets no cap, ensuring this case verifies the
      // SDK's own connectErrorStreak counting rather than accidentally hitting socket.io's native reconnectionAttempts
      socketOptions: { ...fastSocketOptions, reconnectionAttempts: Infinity },
    });
    await client.connect();

    // Simulate the API key being revoked: every handshake from now on (including the manual reconnect triggered by the hard drop below) is rejected
    server.revokeAuth();
    server.disconnectAllSockets();

    await vi.waitFor(() => expect(stopped).toEqual(['retries_exhausted']), { timeout: 8000, interval: 20 });
    const handshakesAtStop = server.handshakeAttempts();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(server.handshakeAttempts()).toBe(handshakesAtStop); // no new handshake attempts after stopping
    expect(errors.length).toBeGreaterThan(0);
  });

  // After 'transport close' (a network blip, not 'io server disconnect') the built-in engine
  // auto-reconnects, but the handshake keeps being rejected (the account was banned / the key
  // revoked while offline) — socket.io treats a handshake-middleware rejection as terminal,
  // emits connect_error once, then sets socket.active=false and never retries on its own. The
  // SDK's manual retry must take over (it cannot recognize only 'io server disconnect'), or the
  // streak stalls at 1, onStopped never fires, and the client dies silently.
  it('transport close 后握手持续被拒：SDK 接管手动重连直至 retries_exhausted，onStopped 触发且终态干净', async () => {
    const stopped: string[] = [];
    const errors: unknown[] = [];
    const { client } = makeClient({
      reconnectionAttempts: 3,
      onStopped: (reason) => stopped.push(reason),
      onError: (error) => errors.push(error),
      // The built-in engine itself gets no cap, ensuring the SDK's own connectErrorStreak counting is what gets verified
      socketOptions: { ...fastSocketOptions, reconnectionAttempts: Infinity },
    });
    await client.connect();
    const handshakesAfterConnect = server.handshakeAttempts();

    // Credentials revoked while offline: every handshake from now on is rejected
    server.revokeAuth();
    // A network-blip style drop (transport close, no DISCONNECT packet) — distinct from disconnectAllSockets' io server disconnect
    server.crashTransport();

    // The streak fills up → proactive stop (had the manual retry not taken over, the streak would stall at 1 and this assertion would time out)
    await vi.waitFor(() => expect(stopped).toEqual(['retries_exhausted']), { timeout: 8000, interval: 20 });
    // Manual reconnects genuinely kept happening in the meantime (handshake attempts grew) — not a silent death
    expect(server.handshakeAttempts()).toBeGreaterThan(handshakesAfterConnect);
    expect(errors.length).toBeGreaterThan(0);

    // After stopping, this.socket has been cleaned up: another connect() yields an explicit terminal rejection instead of a silent no-op from a leftover this.socket
    await expect(client.connect()).rejects.toThrow();
  });

  // When a single malformed envelope shows up in a backfill page (missing eventId, rejected by
  // decodeEnvelope), it is only skipped with an onError report — the backfill round is not
  // aborted and the cursor does not get stuck; mirrors the per-item try/except of the Python SDK's _enqueue_dispatch
  it('补发页中单条畸形信封被跳过并上报，前后合法事件照常投递', async () => {
    const errors: unknown[] = [];
    server.pushEvent({ payload: { index: 0 } }); // seq 1, valid
    server.pushEvent({ eventId: undefined as unknown as string, payload: { bad: true } }); // seq 2, missing eventId → malformed
    server.pushEvent({ payload: { index: 2 } }); // seq 3, valid

    const { client, received } = makeClient({ onError: (error) => errors.push(error) });
    await client.connect();

    // The malformed entry is skipped while seq 1/3 are still delivered as usual (the round was not aborted and the cursor moved past the malformed entry)
    expect(received.map((e) => e.seq)).toEqual(['1', '3']);
    expect(errors.length).toBeGreaterThan(0);
    client.disconnect();
  });

  // Race reproduction: dispatch dedups against the scalar this.cursor (seq<=cursor dropped),
  // but delivery order = enqueueDispatch call order, not seq order. If the WS pushes a new
  // event with a larger seq while the backfill's HTTP request is in flight, it gets dispatched
  // immediately and pushes the cursor up; when the smaller-seq history events from the backfill
  // page arrive afterwards, all of them are misjudged by "seq<=cursor" as already handled and
  // dropped forever (zero deliveries, violating the SDK's declared at-least-once). The fix:
  // live WS events arriving during a backfill are buffered instead of dispatched directly, then
  // merged in ascending seq order once the backfill completes, letting the existing dedup
  // absorb the overlap with the backfill instead of letting live events race the cursor upward.
  describe('backfill 竞态缓冲合流（修复轮 2）', () => {
    it('首连 backfill 请求在途时 WS 推来更大 seq 的新事件，不应让 backfill 页里更小的历史事件被误丢', async () => {
      // Preload a history backlog of seq 1-5
      for (let i = 0; i < 5; i += 1) {
        server.pushEvent({ payload: { index: i } });
      }

      const release = server.pauseEventsResponses();
      const { client, received, persistedSeqs } = makeClient();
      const connectPromise = client.connect();

      // Confirm the backfill's GET /events request is in flight and has not returned yet
      await vi.waitFor(() => expect(server.eventsRequestsReceived()).toBeGreaterThan(0));

      // Push a new event with a larger seq (6) over the WS: this is the race trigger — without
      // buffering it would be dispatched immediately, pushing the cursor to 6, and 1-5 from the
      // backfill page would then be misjudged as "already handled" and dropped
      const pushed = server.pushEvent({ payload: { phase: 'racing-live-event' } });
      expect(pushed.seq).toBe('6');

      release();
      await connectPromise;

      // All six events should be received, ascending by seq, with no gaps and no duplicates
      expect(received.map((e) => e.seq)).toEqual(['1', '2', '3', '4', '5', '6']);
      expect(new Set(received.map((e) => e.eventId)).size).toBe(6);
      expect(persistedSeqs.at(-1)).toBe('6');

      client.disconnect();
    });

    it('重连触发的 backfill 请求在途时 WS 推来更大 seq 的新事件，同样不应丢失更小 seq 的历史事件', async () => {
      const { client, received, persistedSeqs } = makeClient();
      await client.connect(); // empty history, the first connect completes immediately

      // Disconnect and fabricate an offline history backlog of seq 1-5
      server.disconnectAllSockets();
      for (let i = 0; i < 5; i += 1) {
        server.pushEvent({ payload: { index: i } });
      }

      // Suspend GET /events before the reconnect actually happens: the backfill request triggered by the client's reconnect gets stuck behind this gate
      const release = server.pauseEventsResponses();
      const requestsBeforeReconnect = server.eventsRequestsReceived();
      await vi.waitFor(() => expect(server.eventsRequestsReceived()).toBeGreaterThan(requestsBeforeReconnect), {
        timeout: 5000,
        interval: 20,
      });

      // The WS has reconnected by now (it is what triggered this backfill round); push a new event with a larger seq (6) to race it
      const pushed = server.pushEvent({ payload: { phase: 'racing-live-event-on-reconnect' } });
      expect(pushed.seq).toBe('6');

      release();

      await vi.waitFor(() => expect(received).toHaveLength(6), { timeout: 5000, interval: 20 });
      expect(received.map((e) => e.seq)).toEqual(['1', '2', '3', '4', '5', '6']);
      expect(new Set(received.map((e) => e.eventId)).size).toBe(6);
      expect(persistedSeqs.at(-1)).toBe('6');

      client.disconnect();
    });

    it('backfill 期间实时事件缓冲区溢出：整体丢弃缓冲并在补发完成后再补一轮兜底，最终仍不丢不重', async () => {
      const release = server.pauseEventsResponses();
      // The buffer cap is lowered to 2 so the overflow can be triggered controllably in a test, without actually pushing thousands of events
      const { client, received, persistedSeqs } = makeClient({ backfillEventBufferLimit: 2 });
      const connectPromise = client.connect();

      await vi.waitFor(() => expect(server.eventsRequestsReceived()).toBeGreaterThan(0));

      // Push 3 live events, past the buffer cap (2): the 3rd triggers the overflow — the buffer is cleared wholesale and marked overflowed
      server.pushEvent({ payload: { index: 0 } });
      server.pushEvent({ payload: { index: 1 } });
      server.pushEvent({ payload: { index: 2 } });

      const requestsBeforeRelease = server.eventsRequestsReceived();
      release();
      await connectPromise;

      // The overflow triggered the "one more round": an extra GET /events should be observable
      // (the first round's pages already fetched all of 1-3, so the second round returns an
      // empty page for lack of newer events, but the request itself must genuinely have happened)
      await vi.waitFor(() => expect(server.eventsRequestsReceived()).toBeGreaterThan(requestsBeforeRelease));

      // Even though the buffer was discarded wholesale along the way, the final result still has no gaps and no duplicates (thanks to the "one more round" safety net)
      expect(received.map((e) => e.seq)).toEqual(['1', '2', '3']);
      expect(new Set(received.map((e) => e.eventId)).size).toBe(3);
      expect(persistedSeqs.at(-1)).toBe('3');

      client.disconnect();
    });
  });

  // Flush chain-slot locking (critical) + ban notices taking priority over buffering (important)
  describe('flush 链位锁定与封禁即停（修复轮 3）', () => {
    it('flush 期间到达的高 seq 实时事件不应插队抢先推高游标，导致其余缓冲事件被误杀（零投递）', async () => {
      // Preload 1 seed history event (seq1); the first backfill page fetches it normally
      server.pushEvent({ payload: { phase: 'seed-history' } });

      const receivedEvents: OanEventEnvelope[] = [];
      const persistedSeqs: string[] = [];
      let persistCallCount = 0;

      const client = new OanClient({
        baseUrl: server.baseUrl,
        credentials: { apiKey: expectedToken },
        socketOptions: fastSocketOptions,
        // This case verifies the backfill flush race and needs to explicitly start from 0 to receive the seed history event
        restoreCursor: () => '0',
        persistCursor: (seq) => {
          persistCallCount += 1;
          persistedSeqs.push(seq);
          // The 1st call corresponds to handling the seed history event (seq1): normal
          // processing within a backfill page, with buffering still true. Deliberately slow it
          // down to stretch open a window of "still backfilling, but no GET /events request in
          // flight" — live events arriving in this window take only the direct WS path →
          // bufferLiveEvent and cannot be re-captured by any backfill page response, making it
          // easy to construct buffered items that exist purely in pendingBuffer and have never
          // actually been delivered
          if (persistCallCount === 1) {
            return new Promise((resolve) => setTimeout(resolve, 50));
          }
          // The 2nd call corresponds to the flush loop handling the first sorted buffered event
          // in pendingBuffer: slow it down likewise to stretch open the race window this case
          // actually covers — if the flush does not claim the chain slots of every buffered item
          // within one synchronous section, a higher-seq live event arriving during this window
          // jumps the queue, races the cursor up to its own seq, and the buffered items behind
          // it that have not yet entered the chain get misjudged by "seq<=cursor" as already
          // handled and dropped forever
          if (persistCallCount === 2) {
            return new Promise((resolve) => setTimeout(resolve, 50));
          }
          return undefined;
        },
      });
      client.onEvent((envelope) => receivedEvents.push(envelope));

      const connectPromise = client.connect();

      // Wait until the 1st persistCursor call has been issued (synchronously pushed into
      // persistedSeqs), meaning the seed history event is stuck in the artificially slowed window
      await vi.waitFor(() => expect(persistedSeqs).toEqual(['1']), { timeout: 3000, interval: 5 });

      // Push 3 live events (seq2/3/4) within this window: no GET /events request is in flight
      // now, so they get buffered into pendingBuffer via the direct WS path only and cannot
      // reappear in any backfill page response
      server.pushEvent({ payload: { index: 0 } });
      server.pushEvent({ payload: { index: 1 } });
      server.pushEvent({ payload: { index: 2 } });

      // Wait until the 2nd persistCursor call has been issued, meaning the flush loop has begun
      // handling the first sorted entry in pendingBuffer (seq2) and is stuck in the second artificially slowed window
      await vi.waitFor(() => expect(persistedSeqs).toEqual(['1', '2']), { timeout: 3000, interval: 5 });

      // Race trigger: push a new event with a larger seq (5) within this window
      const racing = server.pushEvent({ payload: { phase: 'racing-during-flush' } });
      expect(racing.seq).toBe('5');

      await connectPromise;
      // Give tail events possibly still running on the chain (e.g. the queue-jumping race event itself) time to settle
      await new Promise((resolve) => setTimeout(resolve, 150));

      // All five events should be received, ascending by seq, with no gaps and no duplicates; before the fix, seq3/seq4 got wrongly killed
      expect(receivedEvents.map((e) => e.seq).sort((a, b) => Number(a) - Number(b))).toEqual([
        '1',
        '2',
        '3',
        '4',
        '5',
      ]);
      expect(new Set(receivedEvents.map((e) => e.eventId)).size).toBe(5);
      expect(persistedSeqs).toEqual(['1', '2', '3', '4', '5']);

      client.disconnect();
    });

    it('backfill 缓冲期间到达账户封禁通知应立即投递并停止，不等 flush，且不再发起后续 GET /events', async () => {
      // Suspend the response of the first backfill page: the WS is connected and buffering=true
      // at this point, so ordinary live events go into pendingBuffer first and are not delivered until the flush
      const release = server.pauseEventsResponses();

      const stopped: string[] = [];
      const errors: unknown[] = [];
      const { client, received } = makeClient({
        onStopped: (reason) => stopped.push(reason),
        onError: (error) => errors.push(error),
      });
      const connectPromise = client.connect();

      await vi.waitFor(() => expect(server.eventsRequestsReceived()).toBeGreaterThan(0));

      // Push an ordinary event first and confirm it really is buffered rather than delivered directly (the control group)
      server.pushEvent({ payload: { phase: 'buffered-before-ban' } });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(received).toHaveLength(0);

      const requestsBeforeBan = server.eventsRequestsReceived();

      // While buffering (GET /events still suspended, the backfill nowhere near complete), push
      // an account-banned notice: it should skip the buffer, deliver directly, and trigger stop without waiting for the flush
      server.pushEvent({ type: 'system_notice', payload: { kind: 'account_banned' } });

      await vi.waitFor(() => expect(stopped).toEqual(['account_banned']), { timeout: 3000, interval: 5 });
      expect(errors).toHaveLength(1);
      const banEnvelope = received.find((e) => e.type === 'system_notice');
      expect(banEnvelope?.payload).toMatchObject({ kind: 'account_banned' });

      // Release the suspended GET /events so the backfill/flush can run to completion and the
      // test does not hang; stop() has already cleared pendingBuffer, so the buffered
      // "buffered-before-ban" event is discarded with it — the account is banned, continuing to
      // backfill history is pointless, and this trade-off is explicitly accepted
      release();
      await connectPromise;

      // No new GET /events request should be initiated after the stop
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(server.eventsRequestsReceived()).toBe(requestsBeforeBan);

      client.disconnect();
    });
  });
});
