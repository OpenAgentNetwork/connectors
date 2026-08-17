// Attachment semantics (OAN protocol layer, platform-neutral): inbound — redeem a signed URL
// via the context-appropriate endpoint → download → hand bytes to the host to persist;
// outbound — route the upload endpoint by contact prefix and file extension → attach the
// returned attachmentId to the message.
//
// All OAN protocol semantics live here (endpoint routing, 404 as a terminal state, the 10MB
// cap, the MIME whitelist, per-attachment failure isolation); host capabilities are reduced to
// the two injected OanMediaHostIo callbacks — how inbound bytes are persisted and how an
// outbound file is read.
import type { OanUploadFile } from '@openagentnetwork/client-js';
import { conversationIdFromContactId, goferIdFromContactId } from './contact-id.js';
import type { OanConnectionHandle } from './connection.js';
import { attachmentDisplayName, type InboundMediaRef } from './inbound-mapping.js';
import { syntheticMessageId } from './outbound-completion.js';

/** Per-attachment size limit on the OAN server (10MB, a server-side hard cap; configuring more still gets rejected server-side) */
export const OAN_MEDIA_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Host-injected file IO callbacks: the core owns all protocol semantics; the host only answers
 * "where do bytes come from, where do they go". persistInboundBytes returns a local path
 * (which enters the inbox item's mediaPaths for the agent to read with its own file tools).
 */
export interface OanMediaHostIo {
  persistInboundBytes(input: {
    bytes: Uint8Array;
    name: string;
    mimeType?: string;
    contactId: string;
  }): Promise<string>;
  readOutboundFile(path: string): Promise<{ bytes: Uint8Array; name: string }>;
}

// ---------------------------------------------------------------------------
// Inbound: attachment metadata → signed URL redemption → download → host persistence
// ---------------------------------------------------------------------------

/** One persisted inbound attachment (local path + original metadata) */
export interface OanStagedInboundAttachment {
  path: string;
  kind: 'photo' | 'document';
  name?: string;
  mimeType?: string;
}

export interface StagedInboundMedia {
  /** Attachments persisted to disk (with local paths) */
  media: OanStagedInboundAttachment[];
  /** The body actually used: rewritten with a degradation note when attachments could not be fetched, otherwise unchanged */
  text: string;
  /** Attachments that could not be fetched (redemption 404 / download failure / over the size limit / missing container id), for logging and assertions */
  unavailable: InboundMediaRef[];
}

/**
 * The stager; held by inbound-dispatch via dependency injection so unit tests can pass a pure
 * function stand-in. The owning contactId is passed through to the host's persistInboundBytes,
 * which decides the on-disk layout itself.
 */
export type OanInboundMediaStager = (
  media: readonly InboundMediaRef[],
  text: string,
  contactId: string,
) => Promise<StagedInboundMedia>;

export interface OanInboundMediaOptions {
  /** Per-attachment size limit; defaults to the OAN server cap of 10MB */
  maxBytes?: number;
  /** fetch injection (for tests); defaults to the global fetch */
  fetchImpl?: typeof fetch;
  log?: { warn?: (msg: string) => void };
}

export function createInboundMediaStager(
  connection: OanConnectionHandle,
  hostIo: Pick<OanMediaHostIo, 'persistInboundBytes'>,
  options?: OanInboundMediaOptions,
): OanInboundMediaStager {
  return async (media, text, contactId) => stageInboundMedia(connection, hostIo, options ?? {}, media, text, contactId);
}

/**
 * Each attachment succeeds or fails independently: one failing attachment is merely excluded
 * while the rest persist as usual — a single unfetchable photo should not degrade the whole
 * message to plain text. The body stays unchanged on full success; on any failure a
 * degradation note is appended.
 */
async function stageInboundMedia(
  connection: OanConnectionHandle,
  hostIo: Pick<OanMediaHostIo, 'persistInboundBytes'>,
  options: OanInboundMediaOptions,
  refs: readonly InboundMediaRef[],
  text: string,
  contactId: string,
): Promise<StagedInboundMedia> {
  const staged: OanStagedInboundAttachment[] = [];
  const unavailable: InboundMediaRef[] = [];

  for (const ref of refs) {
    try {
      staged.push(await downloadAttachment(connection, hostIo, options, ref, contactId));
    } catch (error) {
      unavailable.push(ref);
      options.log?.warn?.(`oan: inbound attachment ${ref.attachmentId} unavailable: ${String(error)}`);
    }
  }

  return {
    media: staged,
    text: describeUnavailableAttachments(text, unavailable),
    unavailable,
  };
}

/**
 * Redeem the signed URL, download, and persist. The signed URL points at external object
 * storage, so the download must never carry OAN auth headers — they are useless there and
 * would hand the API key to a host that is not OAN (hence fetch is called with no headers).
 * A 404 on redemption means the attachment was deleted — an explicit terminal state in the
 * protocol, never retried (it counts toward unavailable like any other failure).
 */
async function downloadAttachment(
  connection: OanConnectionHandle,
  hostIo: Pick<OanMediaHostIo, 'persistInboundBytes'>,
  options: OanInboundMediaOptions,
  ref: InboundMediaRef,
  contactId: string,
): Promise<OanStagedInboundAttachment> {
  const url = await redeemAttachmentUrl(connection, ref);
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`signed URL download failed: HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const maxBytes = options.maxBytes ?? OAN_MEDIA_MAX_BYTES;
  if (bytes.byteLength > maxBytes) {
    throw new Error(`attachment exceeds the ${maxBytes}-byte limit (${bytes.byteLength} bytes)`);
  }
  const name = ref.name?.trim() || ref.attachmentId;
  const path = await hostIo.persistInboundBytes({
    bytes,
    name,
    ...(ref.mimeType ? { mimeType: ref.mimeType } : {}),
    contactId,
  });
  return {
    path,
    kind: ref.kind,
    ...(ref.name !== undefined ? { name: ref.name } : {}),
    ...(ref.mimeType !== undefined ? { mimeType: ref.mimeType } : {}),
  };
}

/** Route redemption by context: direct-conversation attachments vs. paired counterpart Gofer material — the two endpoints' authorization semantics are not interchangeable */
async function redeemAttachmentUrl(connection: OanConnectionHandle, ref: InboundMediaRef): Promise<string> {
  if (ref.context === 'conversation') {
    if (!ref.conversationId) throw new Error(`missing conversationId for attachment ${ref.attachmentId}`);
    const { url } = await connection.client.attachments.getConversationAttachmentUrl(
      ref.conversationId,
      ref.attachmentId,
    );
    return url;
  }
  if (!ref.threadId) throw new Error(`missing threadId for attachment ${ref.attachmentId}`);
  const { url } = await connection.client.attachments.getThreadCounterpartAttachmentUrl(
    ref.threadId,
    ref.attachmentId,
  );
  return url;
}

/**
 * Degradation note: attachment names and kinds are already listed in the body by
 * inbound-mapping; this only adds the fact "the bytes never arrived" and what to do about it.
 * Filenames go through attachmentDisplayName here too: this note is also connector-authored
 * text outside the untrusted quote block, sharing the same rendering boundary as the inventory
 * (filenames are counterpart-chosen — a smuggled newline could masquerade as connector narration).
 */
function describeUnavailableAttachments(text: string, unavailable: readonly InboundMediaRef[]): string {
  if (unavailable.length === 0) return text;
  const names = unavailable.map((ref) => attachmentDisplayName(ref.name ?? ref.attachmentId)).join(', ');
  const notice =
    `[${unavailable.length} attachment(s) could not be downloaded: ${names}. ` +
    'Their contents are unavailable to you — ask the sender to resend or to describe them if you need them.]';
  return text ? `${text}\n\n${notice}` : notice;
}

// ---------------------------------------------------------------------------
// Outbound: local file → upload routed by contact/extension → attachmentId sent with the message
// ---------------------------------------------------------------------------

/**
 * Extension → MIME map: the full set the OAN server's MIME whitelist allows (documents
 * pdf/doc/docx/txt/csv + images jpeg/png/webp). Protocol semantics — a self-contained table,
 * independent of any host MIME inference.
 */
export const OAN_MEDIA_EXTENSION_MIME: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  csv: 'text/csv',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/** Infer a whitelisted MIME type from the filename; returns undefined for extensions outside the whitelist */
export function mimeForFileName(fileName: string): string | undefined {
  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
  return extension && extension !== fileName.toLowerCase() ? OAN_MEDIA_EXTENSION_MIME[extension] : undefined;
}

/** One uploaded outbound attachment: the attachmentId is sent along with the message */
export interface OanOutboundAttachment {
  attachmentId: string;
  fileName: string;
  mimeType: string;
}

export interface OanOutboundFileInput {
  /** Target contact: oan:<goferId> (Gofer context) or oan:conv:<conversationId> (conversation context) */
  contactId: string;
  /** Host-readable local file path; bytes are read through hostIo.readOutboundFile */
  filePath: string;
  /** Size limit; defaults to the OAN server cap of 10MB — configuring more still gets rejected server-side */
  maxBytes?: number;
}

/**
 * Upload a local file as an OAN attachment (no message sent). Routed by contact prefix (the
 * only routing criterion):
 * - oan:conv:* → the conversation attachment endpoint;
 * - oan:<goferId> → routed by MIME (image/* to the photo endpoint, everything else to documents);
 * - platform pseudo-contacts and unrecognized prefixes → error (no writable media endpoint).
 * Routing and extension validation happen before reading bytes: never read a file for a target
 * that is bound to fail.
 */
export async function stageOutboundAttachment(
  connection: OanConnectionHandle,
  hostIo: Pick<OanMediaHostIo, 'readOutboundFile'>,
  input: OanOutboundFileInput,
): Promise<OanOutboundAttachment> {
  const conversationId = conversationIdFromContactId(input.contactId);
  const goferId = goferIdFromContactId(input.contactId);
  if (!conversationId && !goferId) {
    throw new Error(`Cannot send media to a non-Gofer OAN contact: ${input.contactId}`);
  }

  const { bytes, name } = await hostIo.readOutboundFile(input.filePath);
  const mimeType = mimeForFileName(name);
  if (!mimeType) {
    throw new Error(
      `Unsupported file type for "${name}". Accepted: pdf, doc, docx, txt, csv, jpg, jpeg, png, webp.`,
    );
  }
  const maxBytes = input.maxBytes ?? OAN_MEDIA_MAX_BYTES;
  if (bytes.byteLength > maxBytes) {
    throw new Error(`File "${name}" is ${bytes.byteLength} bytes — over the ${maxBytes}-byte limit.`);
  }

  const file: OanUploadFile = { data: bytes, filename: name, contentType: mimeType };
  if (conversationId) {
    const { attachment } = await connection.client.attachments.uploadConversationAttachment(conversationId, file);
    return { attachmentId: attachment.attachmentId, fileName: name, mimeType };
  }
  const attachmentId = await uploadGoferFile(connection, goferId as string, file, mimeType);
  return { attachmentId, fileName: name, mimeType };
}

/** Gofer-side MIME routing: images go to the photo endpoint, everything else to documents; both return a usable attachmentId */
async function uploadGoferFile(
  connection: OanConnectionHandle,
  goferId: string,
  file: OanUploadFile,
  mimeType: string,
): Promise<string> {
  if (mimeType.startsWith('image/')) {
    const { photo } = await connection.client.attachments.uploadGoferPhoto(goferId, file);
    return photo.id;
  }
  const { attachment } = await connection.client.attachments.uploadGoferAttachment(goferId, file);
  return attachment.id;
}

export interface OanFileSendResult {
  messageId: string;
  fileName: string;
  attachmentId: string;
}

/**
 * Deliver a local file to an OAN contact as a real attachment (upload + a message carrying
 * attachmentIds, in one step). content is omitted when the caption is empty: the server allows
 * attachment-only messages (content and attachmentIds — at least one of the two). Single-file
 * semantics: one attachment per message (the skill discipline matches the server constraint).
 */
export async function sendOanFile(
  connection: OanConnectionHandle | undefined,
  hostIo: Pick<OanMediaHostIo, 'readOutboundFile'>,
  contactId: string,
  filePath: string,
  caption?: string,
  options?: { maxBytes?: number },
): Promise<OanFileSendResult> {
  if (!connection) {
    throw new Error('OpenAgentNetwork connector is not configured yet.');
  }
  const staged = await stageOutboundAttachment(connection, hostIo, {
    contactId,
    filePath,
    ...(options?.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
  });
  const content = caption?.trim() || undefined;

  const conversationId = conversationIdFromContactId(contactId);
  if (conversationId) {
    await connection.client.conversations.sendMessage(conversationId, content, [staged.attachmentId]);
  } else {
    // stageOutboundAttachment already guarantees non-conversation targets are valid goferIds
    await connection.client.gofers.sendMessage(goferIdFromContactId(contactId) as string, content, [
      staged.attachmentId,
    ]);
  }
  return { messageId: syntheticMessageId(), fileName: staged.fileName, attachmentId: staged.attachmentId };
}
