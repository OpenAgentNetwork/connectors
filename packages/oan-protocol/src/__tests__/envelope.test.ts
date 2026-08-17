import { describe, expect, it } from 'vitest';
import {
  OAN_PROTOCOL_VERSION,
  OAN_WS_NAMESPACE,
  OAN_WS_EVENT,
  OAN_EVENT_TYPES,
  OAN_MESSAGE_SOURCES,
  OAN_REST_PATHS,
} from '../index.js';
import type { OanEventEnvelope, OanEventType, OanMessageSource } from '../index.js';

describe('OAN 协议常量', () => {
  it('协议版本号与 WS 常量符合契约 C2', () => {
    expect(OAN_PROTOCOL_VERSION).toBe(1);
    expect(OAN_WS_NAMESPACE).toBe('/oan');
    expect(OAN_WS_EVENT).toBe('oan:event');
  });

  it('事件类型常量表穷举全部 8 种类型且不重复', () => {
    const expected: OanEventType[] = [
      'gofer_message',
      'gofer_question',
      'session_summary',
      'pair_proposed',
      'match_request',
      'match_decided',
      'relay_message',
      'system_notice',
    ];
    expect(new Set(OAN_EVENT_TYPES).size).toBe(OAN_EVENT_TYPES.length);
    expect([...OAN_EVENT_TYPES].sort()).toEqual([...expected].sort());
  });

  it('消息来源常量表穷举全部 4 种来源且不重复', () => {
    const expected: OanMessageSource[] = [
      'platform',
      'own_gofer',
      'counterpart_gofer',
      'counterpart_party',
    ];
    expect(new Set(OAN_MESSAGE_SOURCES).size).toBe(OAN_MESSAGE_SOURCES.length);
    expect([...OAN_MESSAGE_SOURCES].sort()).toEqual([...expected].sort());
  });
});

describe('OanEventEnvelope 类型编译', () => {
  it('最小样例对象满足类型约束', () => {
    const minimal: OanEventEnvelope = {
      v: OAN_PROTOCOL_VERSION,
      seq: '1',
      eventId: 'evt-1',
      type: 'gofer_message',
      source: 'own_gofer',
      payload: {},
      createdAt: new Date().toISOString(),
    };
    expect(minimal.type).toBe('gofer_message');
  });

  it('携带全部可选字段的样例对象满足类型约束', () => {
    const full: OanEventEnvelope = {
      v: OAN_PROTOCOL_VERSION,
      seq: '42',
      eventId: 'evt-42',
      type: 'gofer_question',
      goferId: 'role-1',
      chatId: 'chat-1',
      threadId: 'thread-1',
      conversationId: 'conv-1',
      source: 'platform',
      responseConstraints: { allowedValues: ['yes', 'no'] },
      reply: { method: 'POST', path: '/gofers/role-1/chat/messages' },
      webUrl: 'https://openagentnetwork.ai/threads/thread-1',
      payload: { text: 'hello' },
      createdAt: new Date().toISOString(),
    };
    expect(full.reply?.method).toBe('POST');
  });
});

describe('OAN_REST_PATHS 常量表', () => {
  it('basePath 为 /api/v1', () => {
    expect(OAN_REST_PATHS.basePath).toBe('/api/v1');
  });

  it('静态路径与契约 C3 一致', () => {
    expect(OAN_REST_PATHS.auth.googleLogin).toBe('/auth/oan/google');
    expect(OAN_REST_PATHS.auth.emailRequestCode).toBe('/auth/oan/email/request-code');
    expect(OAN_REST_PATHS.auth.emailVerify).toBe('/auth/oan/email/verify');
    expect(OAN_REST_PATHS.auth.pairingCodes).toBe('/auth/oan/pairing-codes');
    expect(OAN_REST_PATHS.auth.pairingCodesRedeem).toBe('/auth/oan/pairing-codes/redeem');
    expect(OAN_REST_PATHS.events).toBe('/events');
    expect(OAN_REST_PATHS.gofers.create).toBe('/gofers');
    expect(OAN_REST_PATHS.gofers.list).toBe('/gofers');
    expect(OAN_REST_PATHS.threads.list).toBe('/threads');
    expect(OAN_REST_PATHS.matchRequests.create).toBe('/match-requests');
  });

  it('带参数路径按 goferId/threadId/matchRequestId/conversationId 拼接', () => {
    expect(OAN_REST_PATHS.gofers.chatMessages('role-1')).toBe('/gofers/role-1/chat/messages');
    expect(OAN_REST_PATHS.gofers.chatMessagesHistory('role-1')).toBe(
      '/gofers/role-1/chat/messages',
    );
    expect(OAN_REST_PATHS.gofers.pairings('role-1')).toBe('/gofers/role-1/pairings');
    expect(OAN_REST_PATHS.gofers.pairingDetail('role-1', 'thread-1')).toBe('/gofers/role-1/pairings/thread-1');
    expect(OAN_REST_PATHS.threads.detail('thread-1')).toBe('/threads/thread-1');
    expect(OAN_REST_PATHS.threads.messages('thread-1')).toBe('/threads/thread-1/messages');
    expect(OAN_REST_PATHS.threads.pairConfirm('thread-1')).toBe('/threads/thread-1/pair/confirm');
    expect(OAN_REST_PATHS.matchRequests.decision('mr-1')).toBe('/match-requests/mr-1/decision');
    expect(OAN_REST_PATHS.conversations.messages('conv-1')).toBe('/conversations/conv-1/messages');
  });
});
