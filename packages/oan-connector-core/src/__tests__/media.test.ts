// media.ts: attachment protocol semantics (inbound redemption routing + auth-less download +
// persistence callback; outbound extension routing + size cap + attachmentId sent with the
// message). Host IO uses in-memory callback stand-ins; the network uses a fake fetch.
import { describe, expect, it, vi } from 'vitest';
import type { OanConnectionHandle } from '../connection.js';
import type { InboundMediaRef } from '../inbound-mapping.js';
import {
  createInboundMediaStager,
  mimeForFileName,
  sendOanFile,
  stageOutboundAttachment,
  OAN_MEDIA_MAX_BYTES,
} from '../media.js';
import { PendingReplyTracker } from '../outbound-router.js';

function fakeConnection() {
  return {
    baseUrl: 'https://api.example.com',
    authMode: { kind: 'apiKey' as const, apiKey: 'test-api-key' },
    pendingReplies: new PendingReplyTracker(),
    client: {
      gofers: { sendMessage: vi.fn().mockResolvedValue({ accepted: true }) },
      matchRequests: { decide: vi.fn().mockResolvedValue({ ok: true }) },
      conversations: { sendMessage: vi.fn().mockResolvedValue({ id: 'msg1' }) },
      attachments: {
        uploadGoferAttachment: vi
          .fn()
          .mockResolvedValue({ attachment: { id: 'att-1' }, ragStatus: 'processing' }),
        uploadGoferPhoto: vi.fn().mockResolvedValue({ photo: { id: 'photo-1' } }),
        uploadConversationAttachment: vi
          .fn()
          .mockResolvedValue({ attachment: { attachmentId: 'conv-att-1' } }),
        getConversationAttachmentUrl: vi
          .fn()
          .mockResolvedValue({ url: 'https://storage.example.com/signed/conv-a1' }),
        getThreadCounterpartAttachmentUrl: vi
          .fn()
          .mockResolvedValue({ url: 'https://storage.example.com/signed/thr-a1', expiresAt: 0 }),
      },
    },
  } satisfies OanConnectionHandle & { client: Record<string, unknown> };
}

/** fake fetch: records call arguments and returns the given bytes */
function fakeFetch(bytes: Uint8Array, status = 200) {
  return vi.fn(async (..._args: Parameters<typeof fetch>) => ({
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

function conversationRef(overrides: Partial<InboundMediaRef> = {}): InboundMediaRef {
  return {
    attachmentId: 'a1',
    kind: 'document',
    name: 'notes.pdf',
    mimeType: 'application/pdf',
    context: 'conversation',
    conversationId: 'conv-7',
    ...overrides,
  };
}

describe('入站附件落盘（createInboundMediaStager）', () => {
  it('conversation 上下文：走会话兑换端点，下载后交 persistInboundBytes（带归属联系人），正文原样', async () => {
    const connection = fakeConnection();
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchImpl = fakeFetch(bytes);
    const persistInboundBytes = vi.fn(async () => '/state/oan/media/notes.pdf');
    const stager = createInboundMediaStager(connection, { persistInboundBytes }, { fetchImpl });

    const staged = await stager([conversationRef()], 'original body', 'oan:conv:conv-7');

    expect(connection.client.attachments.getConversationAttachmentUrl).toHaveBeenCalledWith('conv-7', 'a1');
    expect(persistInboundBytes).toHaveBeenCalledWith({
      bytes,
      name: 'notes.pdf',
      mimeType: 'application/pdf',
      contactId: 'oan:conv:conv-7',
    });
    expect(staged.media).toEqual([
      { path: '/state/oan/media/notes.pdf', kind: 'document', name: 'notes.pdf', mimeType: 'application/pdf' },
    ]);
    expect(staged.text).toBe('original body');
    expect(staged.unavailable).toEqual([]);
  });

  it('thread 上下文：走配对对方素材的兑换端点（两条端点语义不可互换）', async () => {
    const connection = fakeConnection();
    const persistInboundBytes = vi.fn(async () => '/state/oan/media/p1.jpg');
    const stager = createInboundMediaStager(connection, { persistInboundBytes }, { fetchImpl: fakeFetch(new Uint8Array(4)) });

    await stager(
      [conversationRef({ context: 'thread', threadId: 'thr-3', conversationId: undefined, kind: 'photo', name: 'p1.jpg', mimeType: 'image/jpeg' })],
      '',
      'oan:g1',
    );

    expect(connection.client.attachments.getThreadCounterpartAttachmentUrl).toHaveBeenCalledWith('thr-3', 'a1');
    expect(connection.client.attachments.getConversationAttachmentUrl).not.toHaveBeenCalled();
  });

  it('兑换出的签名 URL 指向存储主机：fetch 不带 OAN Authorization 头（防 API Key 外泄）', async () => {
    const connection = fakeConnection();
    const fetchImpl = fakeFetch(new Uint8Array(1));
    const stager = createInboundMediaStager(
      connection,
      { persistInboundBytes: vi.fn(async () => '/p') },
      { fetchImpl },
    );

    await stager([conversationRef()], '', 'oan:conv:conv-7');

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toBe('https://storage.example.com/signed/conv-a1');
    // No init passed (or at least no Authorization) — the signed URL itself is the credential
    expect(init === undefined || (init as RequestInit).headers === undefined).toBe(true);
  });

  it('单条失败不拖垮整批：404（已删除终态）计入 unavailable，其余照常落盘，正文追加降级说明', async () => {
    const connection = fakeConnection();
    connection.client.attachments.getConversationAttachmentUrl
      .mockResolvedValueOnce({ url: 'https://storage.example.com/signed/ok' })
      .mockRejectedValueOnce(new Error('HTTP 404 attachment deleted'));
    const persistInboundBytes = vi.fn(async () => '/state/ok.pdf');
    const warn = vi.fn();
    const stager = createInboundMediaStager(
      connection,
      { persistInboundBytes },
      { fetchImpl: fakeFetch(new Uint8Array(2)), log: { warn } },
    );

    const staged = await stager(
      [conversationRef({ attachmentId: 'ok-1', name: 'ok.pdf' }), conversationRef({ attachmentId: 'gone-1', name: 'gone.pdf' })],
      'body',
      'oan:conv:conv-7',
    );

    expect(staged.media).toHaveLength(1);
    expect(staged.unavailable).toHaveLength(1);
    expect(staged.unavailable[0]?.attachmentId).toBe('gone-1');
    expect(staged.text).toContain('body');
    expect(staged.text).toContain('1 attachment(s) could not be downloaded: gone.pdf');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('下载响应非 2xx 计入 unavailable', async () => {
    const connection = fakeConnection();
    const stager = createInboundMediaStager(
      connection,
      { persistInboundBytes: vi.fn(async () => '/p') },
      { fetchImpl: fakeFetch(new Uint8Array(0), 404) },
    );
    const staged = await stager([conversationRef()], 'b', 'oan:conv:conv-7');
    expect(staged.media).toEqual([]);
    expect(staged.unavailable).toHaveLength(1);
  });

  it('超过 maxBytes 的附件不落盘、计入 unavailable', async () => {
    const connection = fakeConnection();
    const persistInboundBytes = vi.fn(async () => '/p');
    const stager = createInboundMediaStager(
      connection,
      { persistInboundBytes },
      { fetchImpl: fakeFetch(new Uint8Array(11)), maxBytes: 10 },
    );
    const staged = await stager([conversationRef()], 'b', 'oan:conv:conv-7');
    expect(persistInboundBytes).not.toHaveBeenCalled();
    expect(staged.unavailable).toHaveLength(1);
  });

  it('缺容器 id（conversation 无 conversationId）计入 unavailable，不发兑换请求', async () => {
    const connection = fakeConnection();
    const stager = createInboundMediaStager(
      connection,
      { persistInboundBytes: vi.fn(async () => '/p') },
      { fetchImpl: fakeFetch(new Uint8Array(1)) },
    );
    const staged = await stager([conversationRef({ conversationId: undefined })], 'b', 'oan:conv:conv-7');
    expect(staged.unavailable).toHaveLength(1);
    expect(connection.client.attachments.getConversationAttachmentUrl).not.toHaveBeenCalled();
  });
});

describe('mimeForFileName（协议白名单映射表）', () => {
  it('覆盖协议允许的全集，大小写不敏感', () => {
    expect(mimeForFileName('a.pdf')).toBe('application/pdf');
    expect(mimeForFileName('a.DOC')).toBe('application/msword');
    expect(mimeForFileName('a.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(mimeForFileName('a.txt')).toBe('text/plain');
    expect(mimeForFileName('a.csv')).toBe('text/csv');
    expect(mimeForFileName('a.jpg')).toBe('image/jpeg');
    expect(mimeForFileName('a.JPEG')).toBe('image/jpeg');
    expect(mimeForFileName('a.png')).toBe('image/png');
    expect(mimeForFileName('a.webp')).toBe('image/webp');
  });

  it('白名单外扩展名与无扩展名返回 undefined', () => {
    expect(mimeForFileName('a.exe')).toBeUndefined();
    expect(mimeForFileName('archive.zip')).toBeUndefined();
    expect(mimeForFileName('noextension')).toBeUndefined();
  });
});

describe('出站附件（stageOutboundAttachment / sendOanFile）', () => {
  const readOutboundFile = (name: string, size = 8) =>
    vi.fn(async () => ({ bytes: new Uint8Array(size), name }));

  it('Gofer 联系人 + 文档扩展名 → 文档端点，返回 attachment id', async () => {
    const connection = fakeConnection();
    const hostIo = { readOutboundFile: readOutboundFile('notes.pdf') };

    const staged = await stageOutboundAttachment(connection, hostIo, { contactId: 'oan:g1', filePath: '/f/notes.pdf' });

    expect(hostIo.readOutboundFile).toHaveBeenCalledWith('/f/notes.pdf');
    expect(connection.client.attachments.uploadGoferAttachment).toHaveBeenCalledWith(
      'g1',
      expect.objectContaining({ filename: 'notes.pdf', contentType: 'application/pdf' }),
    );
    expect(connection.client.attachments.uploadGoferPhoto).not.toHaveBeenCalled();
    expect(staged).toEqual({ attachmentId: 'att-1', fileName: 'notes.pdf', mimeType: 'application/pdf' });
  });

  it('Gofer 联系人 + 图片扩展名 → 照片端点', async () => {
    const connection = fakeConnection();
    const staged = await stageOutboundAttachment(
      connection,
      { readOutboundFile: readOutboundFile('plan.png') },
      { contactId: 'oan:g1', filePath: '/f/plan.png' },
    );
    expect(connection.client.attachments.uploadGoferPhoto).toHaveBeenCalledWith(
      'g1',
      expect.objectContaining({ filename: 'plan.png', contentType: 'image/png' }),
    );
    expect(connection.client.attachments.uploadGoferAttachment).not.toHaveBeenCalled();
    expect(staged.attachmentId).toBe('photo-1');
  });

  it('conversation 联系人 → conversation 附件端点', async () => {
    const connection = fakeConnection();
    const staged = await stageOutboundAttachment(
      connection,
      { readOutboundFile: readOutboundFile('notes.pdf') },
      { contactId: 'oan:conv:conv-9', filePath: '/f/notes.pdf' },
    );
    expect(connection.client.attachments.uploadConversationAttachment).toHaveBeenCalledWith(
      'conv-9',
      expect.objectContaining({ filename: 'notes.pdf' }),
    );
    expect(staged.attachmentId).toBe('conv-att-1');
  });

  it('平台伪联系人不可发媒体，且在读取字节之前就拒绝', async () => {
    const connection = fakeConnection();
    const hostIo = { readOutboundFile: readOutboundFile('notes.pdf') };
    await expect(
      stageOutboundAttachment(connection, hostIo, { contactId: 'oan:platform', filePath: '/f/notes.pdf' }),
    ).rejects.toThrow(/non-Gofer/);
    expect(hostIo.readOutboundFile).not.toHaveBeenCalled();
  });

  it('白名单外扩展名报错并列出可接受类型，不上传', async () => {
    const connection = fakeConnection();
    await expect(
      stageOutboundAttachment(
        connection,
        { readOutboundFile: readOutboundFile('malware.exe') },
        { contactId: 'oan:g1', filePath: '/f/malware.exe' },
      ),
    ).rejects.toThrow(/pdf, doc, docx, txt, csv, jpg, jpeg, png, webp/);
    expect(connection.client.attachments.uploadGoferAttachment).not.toHaveBeenCalled();
  });

  it('超过体积上限报错，不上传（缺省 10MB 服务端硬顶）', async () => {
    const connection = fakeConnection();
    await expect(
      stageOutboundAttachment(
        connection,
        { readOutboundFile: readOutboundFile('big.pdf', 32) },
        { contactId: 'oan:g1', filePath: '/f/big.pdf', maxBytes: 16 },
      ),
    ).rejects.toThrow(/limit/);
    expect(connection.client.attachments.uploadGoferAttachment).not.toHaveBeenCalled();
    expect(OAN_MEDIA_MAX_BYTES).toBe(10 * 1024 * 1024);
  });

  it('sendOanFile（Gofer 语境）：上传后随消息发送 attachmentId，caption 作为正文', async () => {
    const connection = fakeConnection();
    const result = await sendOanFile(
      connection,
      { readOutboundFile: readOutboundFile('notes.pdf') },
      'oan:g1',
      '/f/notes.pdf',
      'the notes',
    );
    expect(connection.client.gofers.sendMessage).toHaveBeenCalledWith('g1', 'the notes', ['att-1']);
    expect(result.fileName).toBe('notes.pdf');
    expect(result.attachmentId).toBe('att-1');
    expect(result.messageId).toMatch(/^oan-out-/);
  });

  it('sendOanFile（conversation 语境）：caption 空白时省略 content（服务端允许纯附件消息）', async () => {
    const connection = fakeConnection();
    await sendOanFile(
      connection,
      { readOutboundFile: readOutboundFile('notes.pdf') },
      'oan:conv:conv-9',
      '/f/notes.pdf',
      '   ',
    );
    expect(connection.client.conversations.sendMessage).toHaveBeenCalledWith('conv-9', undefined, ['conv-att-1']);
  });

  it('sendOanFile：未配置连接时报错，不读取文件', async () => {
    const hostIo = { readOutboundFile: readOutboundFile('notes.pdf') };
    await expect(sendOanFile(undefined, hostIo, 'oan:g1', '/f/notes.pdf')).rejects.toThrow(/not configured/i);
    expect(hostIo.readOutboundFile).not.toHaveBeenCalled();
  });

  it('sendOanFile：上传失败时异常上抛，绝不发出消息', async () => {
    const connection = fakeConnection();
    connection.client.attachments.uploadGoferAttachment.mockRejectedValue(new Error('413 too large'));
    await expect(
      sendOanFile(connection, { readOutboundFile: readOutboundFile('notes.pdf') }, 'oan:g1', '/f/notes.pdf'),
    ).rejects.toThrow(/413/);
    expect(connection.client.gofers.sendMessage).not.toHaveBeenCalled();
  });
});
