// Gofer ↔ host contact/thread ID mapping (each Gofer = one contact thread).
// Everything carries the oan: prefix to avoid collisions with the contact ID spaces of other
// channel integrations on the host; platform-level notifications not tied to a specific Gofer
// (e.g. an account-ban system_notice) land on a fixed platform pseudo-contact.

const CONTACT_ID_PREFIX = 'oan:';
const PLATFORM_SUFFIX = 'platform';
// Post-match direct conversations between owners: a conversation is an account-level resource
// (not tied to a single Gofer; relay_message events carry only a conversationId, no goferId),
// mapped to its own contact prefix with one thread per direct conversation
const CONVERSATION_CONTACT_PREFIX = `${CONTACT_ID_PREFIX}conv:`;

export const PLATFORM_CONTACT_ID = `${CONTACT_ID_PREFIX}${PLATFORM_SUFFIX}`;

export function contactIdForGofer(goferId: string): string {
  return `${CONTACT_ID_PREFIX}${goferId}`;
}

export function contactIdForConversation(conversationId: string): string {
  return `${CONVERSATION_CONTACT_PREFIX}${conversationId}`;
}

/** Recover the direct-conversation id from a contact ID; returns null for non-conversation contacts */
export function conversationIdFromContactId(contactId: string): string | null {
  return contactId.startsWith(CONVERSATION_CONTACT_PREFIX)
    ? contactId.slice(CONVERSATION_CONTACT_PREFIX.length)
    : null;
}

/** Recover the goferId from a contact ID; returns null for the platform pseudo-contact, conversation contacts, and unrecognized prefixes */
export function goferIdFromContactId(contactId: string): string | null {
  if (!contactId.startsWith(CONTACT_ID_PREFIX)) return null;
  if (contactId.startsWith(CONVERSATION_CONTACT_PREFIX)) return null;
  const rest = contactId.slice(CONTACT_ID_PREFIX.length);
  return rest === PLATFORM_SUFFIX ? null : rest;
}

/** Single entry point from event envelope to contact ID: a goferId maps to that Gofer's thread, otherwise the platform thread */
export function contactIdForEnvelope(goferId: string | undefined): string {
  return goferId ? contactIdForGofer(goferId) : PLATFORM_CONTACT_ID;
}
