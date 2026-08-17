import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  uploadGoferAttachment,
  uploadGoferPhoto,
  uploadConversationAttachment,
  getConversationAttachmentUrl,
  getThreadCounterpartAttachmentUrl,
} from '../attachments.js';
import { sendGoferMessage } from '../gofers.js';
import { sendConversationMessage } from '../conversations.js';
import { OanApiError } from '../errors.js';
import { startFakeOanServer, type FakeOanServer } from './helpers/fake-oan-server.js';

// Multipart uploads + attachment URL redemption + attachmentIds serialization in message bodies.
describe('附件上传与取图', () => {
  const expectedToken = 'gofers_valid-token';
  let server: FakeOanServer;

  beforeEach(async () => {
    server = await startFakeOanServer({ expectedToken });
  });

  afterEach(async () => {
    await server.close();
  });

  const sampleFile = { data: new Uint8Array([1, 2, 3, 4]), filename: 'a.pdf', contentType: 'application/pdf' };

  it('multipart 请求带 FormData body，Content-Type 由 fetch 自动生成（带 boundary），不是手写的裸 multipart/form-data', async () => {
    await uploadGoferAttachment(server.baseUrl, { kind: 'apiKey', apiKey: expectedToken }, 'g1', sampleFile);

    const last = server.lastRequest();
    expect(last?.method).toBe('POST');
    expect(last?.pathname).toBe('/api/v1/gofers/g1/attachments');
    // fetch wraps the fields with boundary separators in the actual request body, so the body is necessarily non-empty
    expect(last?.bodyLength).toBeGreaterThan(0);
    expect(last?.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
  });

  it('apiKey 鉴权模式：Authorization 头为 Bearer + apiKey', async () => {
    await uploadGoferPhoto(server.baseUrl, { kind: 'apiKey', apiKey: expectedToken }, 'g1', sampleFile);
    expect(server.lastRequest()?.headers.authorization).toBe(`Bearer ${expectedToken}`);
  });

  it('jwt 鉴权模式：Authorization 头为 Bearer + token', async () => {
    const jwtToken = 'a-jwt-token';
    // In jwt mode this token differs from the server's expectedToken and gets rejected; the
    // test only cares whether the request header itself was set correctly, so the expected 401 is absorbed with a catch
    await expect(
      uploadConversationAttachment(server.baseUrl, { kind: 'jwt', token: jwtToken }, 'conv1', sampleFile),
    ).rejects.toBeInstanceOf(OanApiError);
    expect(server.lastRequest()?.headers.authorization).toBe(`Bearer ${jwtToken}`);
  });

  it('错误响应转换为带 status/code 的 OanApiError', async () => {
    await expect(
      uploadGoferAttachment(server.baseUrl, { kind: 'apiKey', apiKey: 'wrong-token' }, 'g1', sampleFile),
    ).rejects.toMatchObject({ name: 'OanApiError', status: 401, code: 'UNAUTHORIZED' });
  });

  it('uploadGoferAttachment 返回 AttachmentUploadResult 形状', async () => {
    const result = await uploadGoferAttachment(server.baseUrl, { kind: 'apiKey', apiKey: expectedToken }, 'g1', sampleFile);
    expect(result).toMatchObject({
      attachment: { id: 'att-1', mimeType: 'application/pdf' },
      ragStatus: 'processing',
    });
  });

  it('uploadGoferPhoto 返回 { photo } 形状', async () => {
    const result = await uploadGoferPhoto(server.baseUrl, { kind: 'apiKey', apiKey: expectedToken }, 'g1', sampleFile);
    expect(result).toMatchObject({ photo: { id: 'photo-1', width: 100, height: 200 } });
  });

  it('uploadConversationAttachment 透传 kind query 并返回净化后的 OanConversationAttachment 形状', async () => {
    const result = await uploadConversationAttachment(
      server.baseUrl,
      { kind: 'apiKey', apiKey: expectedToken },
      'conv1',
      sampleFile,
      { kind: 'document' },
    );
    expect(server.lastRequest()?.pathname).toBe('/api/v1/conversations/conv1/attachments');
    expect(result).toMatchObject({ attachment: { attachmentId: 'conv-att-1', kind: 'document' } });
  });

  it('getConversationAttachmentUrl 解析 {url}', async () => {
    const result = await getConversationAttachmentUrl(server.baseUrl, { kind: 'apiKey', apiKey: expectedToken }, 'conv1', 'att1');
    expect(result).toEqual({ url: 'https://signed.example.com/conversation-attachment' });
  });

  it('getConversationAttachmentUrl 对已删除附件（404）抛出 OanApiError', async () => {
    await expect(
      getConversationAttachmentUrl(server.baseUrl, { kind: 'apiKey', apiKey: expectedToken }, 'conv1', 'missing-attachment'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('getThreadCounterpartAttachmentUrl 解析 {url, expiresAt}', async () => {
    const result = await getThreadCounterpartAttachmentUrl(server.baseUrl, { kind: 'apiKey', apiKey: expectedToken }, 'thread1', 'att1');
    expect(result).toEqual({ url: 'https://signed.example.com/counterpart-attachment', expiresAt: 1893456000000 });
  });
});

// attachmentIds appears in the JSON body only when the caller provides it explicitly; either one of content/attachmentIds may be omitted.
describe('消息体 attachmentIds 序列化', () => {
  const expectedToken = 'gofers_valid-token';
  let server: FakeOanServer;

  beforeEach(async () => {
    server = await startFakeOanServer({ expectedToken });
  });

  afterEach(async () => {
    await server.close();
  });

  it('sendGoferMessage 未传 attachmentIds 时，请求体不含该键', async () => {
    await sendGoferMessage(server.baseUrl, { kind: 'apiKey', apiKey: expectedToken }, 'g1', '你好');
    const raw = server.lastRequest()?.bodyText;
    expect(raw).not.toBeUndefined();
    expect(JSON.parse(raw!)).toEqual({ content: '你好' });
  });

  it('sendGoferMessage 传入 attachmentIds 时，请求体带上该数组', async () => {
    await sendGoferMessage(server.baseUrl, { kind: 'apiKey', apiKey: expectedToken }, 'g1', undefined, ['att-1']);
    const raw = server.lastRequest()?.bodyText;
    expect(JSON.parse(raw!)).toEqual({ attachmentIds: ['att-1'] });
  });

  it('sendConversationMessage 传入 attachmentIds 时，请求体同时带上 content 与 attachmentIds', async () => {
    await sendConversationMessage(server.baseUrl, { kind: 'apiKey', apiKey: expectedToken }, 'conv1', '你好', ['att-1', 'att-2']);
    const raw = server.lastRequest()?.bodyText;
    expect(JSON.parse(raw!)).toEqual({ content: '你好', attachmentIds: ['att-1', 'att-2'] });
  });
});
