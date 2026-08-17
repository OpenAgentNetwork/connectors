// OAN attachment upload/fetch module (the protocol document's attachment endpoint family):
// Gofer document/photo uploads, conversation attachment uploads, and the two short-lived
// signed-URL redemption endpoints (the conversation attachment itself / the paired counterpart
// Gofer's attachment).
//
// File input is uniformly described as { data, filename, contentType? }: data accepts
// Uint8Array | Buffer (a Node Buffer is itself a Uint8Array subclass), so callers on Node 18+
// (native fetch/FormData/Blob) and in browsers never construct a Blob/File themselves per
// environment — this module converts everything into one Blob field on a FormData.
import { OAN_REST_PATHS } from '@openagentnetwork/protocol';
import { oanRequest, oanRequestMultipart, type AuthMode } from './rest-client.js';
import type { OanConversationAttachment } from './conversations.js';

/** File to upload: filename/contentType feed the server's MIME allowlist check and the persisted file name */
export interface OanUploadFile {
  data: Uint8Array | Buffer;
  filename: string;
  contentType?: string;
}

// Converts the uniform file description into the FormData a multipart request needs; the field
// name is fixed to 'file' (server convention). The data is copied via the Uint8Array
// constructor: BlobPart requires the backing store to be an ArrayBuffer (not a
// SharedArrayBuffer), which the caller's Uint8Array/Buffer cannot guarantee at the type level —
// copying satisfies the type constraint, and with the 10MB attachment cap the copy cost is negligible
function toFormData(file: OanUploadFile): FormData {
  const form = new FormData();
  const bytes = new Uint8Array(file.data);
  const blob = new Blob([bytes], file.contentType ? { type: file.contentType } : undefined);
  form.append('file', blob, file.filename);
  return form;
}

/**
 * Document RAG processing status: 'processing' (parsing in the background; the upload response
 * may still carry this value — the server record is authoritative) | 'ready' (done) | 'failed'
 * (document-processing service not configured) | 'unsupported' (MIME storable but no parser)
 */
export type OanRagStatus = 'processing' | 'ready' | 'failed' | 'unsupported';

export interface OanRoleAttachment {
  id: string;
  name: string;
  /**
   * In the upload response this is a short-lived signed download URL (roughly 1 hour of
   * validity), minted only for this response; what the server persists is an internal storage
   * key, not this link. Treat it as an expiring credential: do not store it, do not forward it —
   * once expired, v1 offers no gofer-side redemption endpoint to obtain another.
   */
  url: string;
  mimeType: string;
  size: number;
  ragStatus?: OanRagStatus;
  ragError?: string;
}

export interface OanAttachmentUploadResult {
  attachment: OanRoleAttachment;
  ragStatus: OanRagStatus;
  ragError?: string;
}

// Uploads a Gofer document attachment (10MB cap, MIME allowlist: pdf/doc/docx/txt/csv).
// The attachment.id obtained on success feeds later sendGoferMessage attachmentIds
export async function uploadGoferAttachment(
  baseUrl: string,
  auth: AuthMode,
  goferId: string,
  file: OanUploadFile,
): Promise<OanAttachmentUploadResult> {
  return oanRequestMultipart<OanAttachmentUploadResult>(baseUrl, OAN_REST_PATHS.gofers.attachments(goferId), {
    form: toFormData(file),
    auth,
  });
}

export interface OanGoferPhoto {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  width: number | null;
  height: number | null;
}

// Uploads a Gofer photo (10MB cap, MIME allowlist: image/jpeg|png|webp).
// The photo.id obtained on success is likewise usable in sendGoferMessage attachmentIds
export async function uploadGoferPhoto(
  baseUrl: string,
  auth: AuthMode,
  goferId: string,
  file: OanUploadFile,
): Promise<{ photo: OanGoferPhoto }> {
  return oanRequestMultipart<{ photo: OanGoferPhoto }>(baseUrl, OAN_REST_PATHS.gofers.photos(goferId), {
    form: toFormData(file),
    auth,
  });
}

// Uploads an attachment for the post-match direct channel: upload first to obtain an
// attachmentId, then pass it to sendConversationMessage. When kind is omitted the server infers
// it from the MIME type (image/* → photo, otherwise document); width/height matter only for photos
export async function uploadConversationAttachment(
  baseUrl: string,
  auth: AuthMode,
  conversationId: string,
  file: OanUploadFile,
  options?: { kind?: 'photo' | 'document'; width?: number; height?: number },
): Promise<{ attachment: OanConversationAttachment }> {
  return oanRequestMultipart<{ attachment: OanConversationAttachment }>(
    baseUrl,
    OAN_REST_PATHS.conversations.attachments(conversationId),
    {
      form: toFormData(file),
      auth,
      query: { kind: options?.kind, width: options?.width, height: options?.height },
    },
  );
}

// Redeems a short-lived signed download URL (3600s TTL) for a conversation attachment.
// 404 = the attachment was deleted; this is explicit protocol semantics and must not be retried as a transient error
export async function getConversationAttachmentUrl(
  baseUrl: string,
  auth: AuthMode,
  conversationId: string,
  attachmentId: string,
): Promise<{ url: string }> {
  return oanRequest<{ url: string }>(
    baseUrl,
    OAN_REST_PATHS.conversations.attachmentUrl(conversationId, attachmentId),
    { method: 'GET', auth },
  );
}

// Redeems a short-lived signed download URL for the paired counterpart Gofer's attachment:
// pairing implies full sharing, so no messageId lookup is involved — only threadId +
// attachmentId. A 404 likewise means the attachment was deleted or no longer belongs to the
// counterpart, and must not be retried
export async function getThreadCounterpartAttachmentUrl(
  baseUrl: string,
  auth: AuthMode,
  threadId: string,
  attachmentId: string,
): Promise<{ url: string; expiresAt: number }> {
  return oanRequest<{ url: string; expiresAt: number }>(
    baseUrl,
    OAN_REST_PATHS.threads.counterpartAttachmentUrl(threadId, attachmentId),
    { method: 'GET', auth },
  );
}
