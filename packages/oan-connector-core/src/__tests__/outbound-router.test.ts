import type { OanEventEnvelope } from '@openagentnetwork/client-js';
import { describe, expect, it } from 'vitest';
import { PendingReplyTracker, routeOutbound } from '../outbound-router.js';

function envelope(overrides: Partial<OanEventEnvelope>): OanEventEnvelope {
  return {
    v: 1,
    seq: '1',
    eventId: 'evt-1',
    type: 'match_request',
    source: 'platform',
    payload: {},
    createdAt: '2026-07-10T00:00:00.000Z',
    ...overrides,
  };
}

describe('routeOutbound', () => {
  it('defaults to a Gofer chat message when nothing is pending', () => {
    const action = routeOutbound('g1', 'hi there', undefined);
    expect(action).toEqual({ kind: 'goferMessage', goferId: 'g1', content: 'hi there' });
  });

  it('defaults to a Gofer chat message for a pending gofer_message/gofer_question (same target anyway)', () => {
    const pending = envelope({ type: 'gofer_question', reply: { method: 'POST', path: '/api/v1/gofers/g1/chat/messages' } });
    const action = routeOutbound('g1', 'the answer', pending);
    expect(action).toEqual({ kind: 'goferMessage', goferId: 'g1', content: 'the answer' });
  });

  it('routes an affirmative reply to a pending match_request as a matchDecision', () => {
    const pending = envelope({
      type: 'match_request',
      payload: { requestId: 'req-1' },
      reply: { method: 'POST', path: '/api/v1/match-requests/req-1/decision' },
    });
    expect(routeOutbound('g1', 'yes', pending)).toEqual({ kind: 'matchDecision', requestId: 'req-1', accept: true });
    expect(routeOutbound('g1', 'no', pending)).toEqual({ kind: 'matchDecision', requestId: 'req-1', accept: false });
  });

  it('asks for clarification when a pending match_request reply is ambiguous', () => {
    const pending = envelope({
      type: 'match_request',
      payload: { requestId: 'req-1' },
      reply: { method: 'POST', path: '/api/v1/match-requests/req-1/decision' },
    });
    const action = routeOutbound('g1', 'maybe', pending);
    expect(action.kind).toBe('needsClarification');
  });

  it('routes a pending pair_proposed decision using threadId/goferId from the envelope', () => {
    const pending = envelope({
      type: 'pair_proposed',
      threadId: 'thread-1',
      goferId: 'g1',
      reply: { method: 'POST', path: '/api/v1/threads/thread-1/pair/confirm' },
    });
    expect(routeOutbound('g1', 'accept', pending)).toEqual({
      kind: 'pairConfirm',
      threadId: 'thread-1',
      roleId: 'g1',
      accepted: true,
    });
  });

  it('routes a pending relay_message to the conversation endpoint', () => {
    const pending = envelope({
      type: 'relay_message',
      conversationId: 'conv-1',
      reply: { method: 'POST', path: '/api/v1/conversations/conv-1/messages' },
    });
    expect(routeOutbound('g1', 'thanks!', pending)).toEqual({
      kind: 'conversationMessage',
      conversationId: 'conv-1',
      content: 'thanks!',
    });
  });

  it('falls back to a Gofer message if relay_message is pending without a conversationId', () => {
    const pending = envelope({ type: 'relay_message', reply: { method: 'POST', path: '/x' } });
    expect(routeOutbound('g1', 'hi', pending)).toEqual({ kind: 'goferMessage', goferId: 'g1', content: 'hi' });
  });
});

describe('PendingReplyTracker', () => {
  it('only records envelopes that carry a reply field', () => {
    const tracker = new PendingReplyTracker();
    tracker.record('oan:g1', envelope({ type: 'session_summary', reply: undefined }));
    expect(tracker.peek('oan:g1')).toBeUndefined();
  });

  it('records and clears per-contact pending state', () => {
    const tracker = new PendingReplyTracker();
    const pending = envelope({ reply: { method: 'POST', path: '/x' } });
    tracker.record('oan:g1', pending);
    expect(tracker.peek('oan:g1')).toBe(pending);
    tracker.clear('oan:g1');
    expect(tracker.peek('oan:g1')).toBeUndefined();
  });

  it('keeps the latest reply-bearing envelope per contact', () => {
    const tracker = new PendingReplyTracker();
    const first = envelope({ eventId: 'e1', reply: { method: 'POST', path: '/x' } });
    const second = envelope({ eventId: 'e2', reply: { method: 'POST', path: '/y' } });
    tracker.record('oan:g1', first);
    tracker.record('oan:g1', second);
    expect(tracker.peek('oan:g1')).toBe(second);
  });
});
