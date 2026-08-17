// Core outbound-text logic: depends on no host package, so it unit-tests independently of any
// real host; the adapter wraps it into its own host's outbound message interface.
import { conversationIdFromContactId, goferIdFromContactId } from './contact-id.js';
import type { OanConnectionHandle } from './connection.js';
import { routeOutbound } from './outbound-router.js';
import { syntheticMessageId } from './outbound-completion.js';
import { confirmPairing } from './thread-pair-confirm.js';

export async function sendOanText(
  connection: OanConnectionHandle | undefined,
  contactId: string,
  text: string,
): Promise<{ messageId: string }> {
  if (!connection) {
    throw new Error('OpenAgentNetwork connector is not configured yet.');
  }
  // Direct-conversation contacts (oan:conv:*): outbound always hits that conversation's message endpoint — no routing ambiguity
  const conversationId = conversationIdFromContactId(contactId);
  if (conversationId) {
    await connection.client.conversations.sendMessage(conversationId, text);
    return { messageId: syntheticMessageId() };
  }
  const goferId = goferIdFromContactId(contactId);
  if (!goferId) {
    throw new Error(`Cannot send to a non-Gofer OAN contact: ${contactId}`);
  }

  const pending = connection.pendingReplies.peek(contactId);
  const action = routeOutbound(goferId, text, pending);

  switch (action.kind) {
    case 'goferMessage':
      await connection.client.gofers.sendMessage(action.goferId, action.content);
      return { messageId: syntheticMessageId() };
    case 'matchDecision':
      await connection.client.matchRequests.decide(action.requestId, action.accept);
      connection.pendingReplies.clear(contactId);
      return { messageId: syntheticMessageId() };
    case 'pairConfirm':
      try {
        await confirmPairing(connection.baseUrl, connection.authMode, action.threadId, {
          roleId: action.roleId,
          accepted: action.accepted,
        });
      } catch (error) {
        // In the server's automatic-pairing mode, pair_proposed events still carry a reply
        // target (a known server-side semantic quirk), and the confirmation endpoint rejects
        // with 400 "Thread is not waiting for confirmation" — at that point the pairing is
        // already in effect and the user's confirmation no longer applies: clear the pending
        // state and absorb silently rather than treating it as a delivery failure.
        if (error instanceof Error && error.message.includes('Thread is not waiting for confirmation')) {
          connection.pendingReplies.clear(contactId);
          return { messageId: syntheticMessageId() };
        }
        throw error;
      }
      connection.pendingReplies.clear(contactId);
      return { messageId: syntheticMessageId() };
    case 'conversationMessage':
      await connection.client.conversations.sendMessage(action.conversationId, action.content);
      connection.pendingReplies.clear(contactId);
      return { messageId: syntheticMessageId() };
    case 'needsClarification':
      // Leave the pending state untouched (no clear): the user's next explicit yes/no reply should still hit the same pending decision
      throw new Error(action.hint);
  }
}
