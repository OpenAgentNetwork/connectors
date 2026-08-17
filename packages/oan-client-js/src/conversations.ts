// OAN post-match direct-channel module (the protocol document's conversations endpoints).
// conversationId comes from the match_decided event payload; after sending, the counterpart receives it via a relay_message event.
import { OAN_REST_PATHS } from '@openagentnetwork/protocol';
import { oanRequest, type AuthMode } from './rest-client.js';

/**
 * The sanitized external shape of a conversation attachment (the only shape, see protocol
 * document §2.4): the upload response, the attachments array in message history, and the
 * attachments field of relay_message events all use it; internal fields such as storageKey/
 * ownerUserId/conversationId/status are never included.
 */
export interface OanConversationAttachment {
  attachmentId: string;
  kind: 'photo' | 'document';
  name: string;
  mimeType: string;
  size: number;
  /** Present on photo attachments only */
  width?: number;
  /** Present on photo attachments only */
  height?: number;
}

// Sanitized external shape: no metadata, and retracted messages (deletedAt set) never appear
export interface OanConversationMessage {
  id: string;
  senderUserId: string;
  content: string;
  attachments: OanConversationAttachment[];
  /** Server-side monotonically increasing change sequence (stringified bigint); only comparable within the same conversationId */
  changeSequence: string;
  createdAt: string;
}

// Sends one direct-channel message: POST /conversations/:id/messages {content?, attachmentIds?}
// content and attachmentIds: at least one is required (server-enforced; the SDK does not
// re-validate) — an attachment-only message is valid, and when content is omitted the undefined
// value in the body below is dropped automatically by JSON.stringify, so no empty-string
// misreads occur. attachmentIds carries at most 10 elements, the attachmentId values returned
// by uploadConversationAttachment
export async function sendConversationMessage(
  baseUrl: string,
  auth: AuthMode,
  conversationId: string,
  content?: string,
  attachmentIds?: string[],
): Promise<OanConversationMessage> {
  return oanRequest<OanConversationMessage>(baseUrl, OAN_REST_PATHS.conversations.messages(conversationId), {
    method: 'POST',
    auth,
    body: { content, attachmentIds },
  });
}

// Fetches direct-channel history: GET /conversations/:id/messages?since=&limit= (since is the changeSequence cursor within this conversation)
export async function getConversationMessages(
  baseUrl: string,
  auth: AuthMode,
  conversationId: string,
  since?: string,
  limit?: number,
): Promise<OanConversationMessage[]> {
  return oanRequest<OanConversationMessage[]>(baseUrl, OAN_REST_PATHS.conversations.messages(conversationId), {
    method: 'GET',
    auth,
    query: { since, limit },
  });
}
