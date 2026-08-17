import type { OanEventEnvelope } from '@openagentnetwork/client-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OanConnectionHandle } from '../connection.js';
import { PendingReplyTracker } from '../outbound-router.js';
import { sendOanText } from '../send-text.js';

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

function fakeConnection(): OanConnectionHandle & {
  client: { gofers: { sendMessage: ReturnType<typeof vi.fn> }; matchRequests: { decide: ReturnType<typeof vi.fn> }; conversations: { sendMessage: ReturnType<typeof vi.fn> } };
} {
  return {
    baseUrl: 'https://api.example.com',
    authMode: { kind: 'apiKey', apiKey: 'test-api-key' },
    pendingReplies: new PendingReplyTracker(),
    client: {
      gofers: { sendMessage: vi.fn().mockResolvedValue({ accepted: true }) },
      matchRequests: { decide: vi.fn().mockResolvedValue({ ok: true, status: 'accepted', matchId: 'm1', conversationId: 'c1' }) },
      conversations: { sendMessage: vi.fn().mockResolvedValue({ id: 'msg1' }) },
      // Outbound text never touches the attachment endpoints; present only to satisfy OanConnectionHandle's structural constraint
      attachments: {
        uploadGoferAttachment: vi.fn(),
        uploadGoferPhoto: vi.fn(),
        uploadConversationAttachment: vi.fn(),
        getConversationAttachmentUrl: vi.fn(),
        getThreadCounterpartAttachmentUrl: vi.fn(),
      },
    },
  };
}

describe('sendOanText', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('throws when the connector is not configured yet', async () => {
    await expect(sendOanText(undefined, 'oan:g1', 'hi')).rejects.toThrow(/not configured/i);
  });

  it('routes a conversation contact (oan:conv:*) straight to the conversation endpoint', async () => {
    const connection = fakeConnection();
    const result = await sendOanText(connection, 'oan:conv:conv-9', 'see you Saturday');
    expect(connection.client.conversations.sendMessage).toHaveBeenCalledWith('conv-9', 'see you Saturday');
    expect(result.messageId).toMatch(/^oan-out-/);
  });

  it('throws for a non-Gofer contact id', async () => {
    const connection = fakeConnection();
    await expect(sendOanText(connection, 'oan:platform', 'hi')).rejects.toThrow(/non-Gofer/);
  });

  it('sends a Gofer chat message by default (no pending reply)', async () => {
    const connection = fakeConnection();
    const result = await sendOanText(connection, 'oan:g1', 'hello there');
    expect(connection.client.gofers.sendMessage).toHaveBeenCalledWith('g1', 'hello there');
    expect(result.messageId).toMatch(/^oan-out-/);
  });

  it('routes a match_request decision and clears the pending state', async () => {
    const connection = fakeConnection();
    connection.pendingReplies.record(
      'oan:g1',
      envelope({ type: 'match_request', payload: { requestId: 'req-1' }, reply: { method: 'POST', path: '/x' } }),
    );

    await sendOanText(connection, 'oan:g1', 'yes');

    expect(connection.client.matchRequests.decide).toHaveBeenCalledWith('req-1', true);
    expect(connection.pendingReplies.peek('oan:g1')).toBeUndefined();
  });

  it('routes a relay_message reply to the conversation endpoint and clears the pending state', async () => {
    const connection = fakeConnection();
    connection.pendingReplies.record(
      'oan:g1',
      envelope({ type: 'relay_message', conversationId: 'conv-1', reply: { method: 'POST', path: '/x' } }),
    );

    await sendOanText(connection, 'oan:g1', 'thanks!');

    expect(connection.client.conversations.sendMessage).toHaveBeenCalledWith('conv-1', 'thanks!');
    expect(connection.pendingReplies.peek('oan:g1')).toBeUndefined();
  });

  it('routes a pair_proposed confirmation via a direct fetch call and clears the pending state', async () => {
    const connection = fakeConnection();
    connection.pendingReplies.record(
      'oan:g1',
      envelope({ type: 'pair_proposed', threadId: 'thread-1', goferId: 'g1', reply: { method: 'POST', path: '/x' } }),
    );
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, text: async () => '' });

    await sendOanText(connection, 'oan:g1', 'accept');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain('/threads/thread-1/pair/confirm');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ roleId: 'g1', accepted: true });
    expect(connection.pendingReplies.peek('oan:g1')).toBeUndefined();
  });

  it('自动配对模式：pair/confirm 返回 400 not-waiting 时静默吸收并清挂起（不算投递失败）', async () => {
    const connection = fakeConnection();
    connection.pendingReplies.record(
      'oan:g1',
      envelope({ type: 'pair_proposed', threadId: 'thread-1', goferId: 'g1', reply: { method: 'POST', path: '/x' } }),
    );
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":"Thread is not waiting for confirmation.","code":"BAD_REQUEST"}',
    });

    const result = await sendOanText(connection, 'oan:g1', 'yes');
    expect(result.messageId).toBeTruthy();
    expect(connection.pendingReplies.peek('oan:g1')).toBeUndefined();
  });

  it('throws with a clarification hint and keeps the pending state on ambiguous decisions', async () => {
    const connection = fakeConnection();
    const pending = envelope({ type: 'match_request', payload: { requestId: 'req-1' }, reply: { method: 'POST', path: '/x' } });
    connection.pendingReplies.record('oan:g1', pending);

    await expect(sendOanText(connection, 'oan:g1', 'maybe later')).rejects.toThrow(/YES/);
    expect(connection.pendingReplies.peek('oan:g1')).toBe(pending);
  });
});
