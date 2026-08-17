// OAN Gofer creation and role-chat module (the protocol document's gofers endpoints).
import { OAN_REST_PATHS } from '@openagentnetwork/protocol';
import { oanRequest, type AuthMode } from './rest-client.js';

export interface OanGoferCreateResult {
  goferId: string;
  chatId: string;
  greeting: string;
  /** The platform web page where the owner can view this Gofer's full two-way conversation history; absent when the deployment does not configure OAN_WEB_BASE_URL */
  webUrl?: string;
}

/** discoveryStatus: 'in_discovery' (still in the discovery phase) | 'ready_for_pairing' (eligible for pairing) */
export interface OanGoferListItem {
  goferId: string;
  name: string;
  description: string;
  discoveryStatus: 'in_discovery' | 'ready_for_pairing';
  createdAt: string;
  /** The platform web page where the owner can view this Gofer's full two-way conversation history; absent when the deployment does not configure OAN_WEB_BASE_URL */
  webUrl?: string;
}

/** role: 'user' | 'assistant' | 'system' */
export interface OanGoferChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
}

// Creates a Gofer (placeholder role + lazily bound role-chat; the server has already persisted the seed greeting)
export async function createGofer(
  baseUrl: string,
  auth: AuthMode,
  input?: { locale?: string; humanReviewTriggers?: string[] },
): Promise<OanGoferCreateResult> {
  return oanRequest<OanGoferCreateResult>(baseUrl, OAN_REST_PATHS.gofers.create, {
    method: 'POST',
    auth,
    body: input ?? {},
  });
}

// Lists this account's Gofers
export async function listGofers(baseUrl: string, auth: AuthMode): Promise<OanGoferListItem[]> {
  return oanRequest<OanGoferListItem[]>(baseUrl, OAN_REST_PATHS.gofers.list, {
    method: 'GET',
    auth,
  });
}

// Deletes one of this account's Gofers (irreversible; the server cascades to its conversations and match data)
export async function deleteGofer(
  baseUrl: string,
  auth: AuthMode,
  goferId: string,
): Promise<{ deleted: boolean; goferId: string }> {
  return oanRequest<{ deleted: boolean; goferId: string }>(baseUrl, OAN_REST_PATHS.gofers.delete(goferId), {
    method: 'DELETE',
    auth,
  });
}

// Sends one message to the Gofer's role-chat (202 returns immediately; the assistant's reply
// arrives asynchronously via gofer_message/gofer_question events). content and attachmentIds:
// at least one is required (server-enforced) — an attachment-only message is valid, and when
// content is omitted the undefined value in the body below is dropped automatically by
// JSON.stringify. attachmentIds carries at most 1 element, the id returned by
// uploadGoferAttachment/uploadGoferPhoto
export async function sendGoferMessage(
  baseUrl: string,
  auth: AuthMode,
  goferId: string,
  content?: string,
  attachmentIds?: string[],
): Promise<{ accepted: boolean }> {
  return oanRequest<{ accepted: boolean }>(baseUrl, OAN_REST_PATHS.gofers.chatMessages(goferId), {
    method: 'POST',
    auth,
    body: { content, attachmentIds },
  });
}

// Fetches the Gofer's role-chat history; since is an ISO timestamp, recommended only for a
// one-off history catch-up and not as a dedup cursor for incremental delivery (see protocol
// document §3) — day-to-day increments should be driven by gofer_message/gofer_question events
export async function getGoferChatMessages(
  baseUrl: string,
  auth: AuthMode,
  goferId: string,
  since?: string,
): Promise<OanGoferChatMessage[]> {
  return oanRequest<OanGoferChatMessage[]>(baseUrl, OAN_REST_PATHS.gofers.chatMessagesHistory(goferId), {
    method: 'GET',
    auth,
    query: since ? { since } : undefined,
  });
}
