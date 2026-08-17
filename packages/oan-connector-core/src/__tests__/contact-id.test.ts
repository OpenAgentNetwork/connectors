import { describe, expect, it } from 'vitest';
import {
  contactIdForConversation,
  contactIdForEnvelope,
  contactIdForGofer,
  conversationIdFromContactId,
  goferIdFromContactId,
  PLATFORM_CONTACT_ID,
} from '../contact-id.js';

describe('contact-id', () => {
  it('adds the oan: prefix for a Gofer contact id', () => {
    expect(contactIdForGofer('gofer-1')).toBe('oan:gofer-1');
  });

  it('round-trips goferIdFromContactId(contactIdForGofer(x)) === x', () => {
    expect(goferIdFromContactId(contactIdForGofer('gofer-42'))).toBe('gofer-42');
  });

  it('returns null for the platform pseudo-contact', () => {
    expect(goferIdFromContactId(PLATFORM_CONTACT_ID)).toBeNull();
  });

  it('returns null for an unrecognized prefix', () => {
    expect(goferIdFromContactId('other-channel:123')).toBeNull();
  });

  it('contactIdForEnvelope falls back to the platform contact when goferId is absent', () => {
    expect(contactIdForEnvelope(undefined)).toBe(PLATFORM_CONTACT_ID);
    expect(contactIdForEnvelope('gofer-1')).toBe('oan:gofer-1');
  });
});

describe('conversation contact ids', () => {
  it('round-trips conversation contact ids and never parses them as gofers', () => {
    const contactId = contactIdForConversation('conv-1');
    expect(contactId).toBe('oan:conv:conv-1');
    expect(conversationIdFromContactId(contactId)).toBe('conv-1');
    expect(goferIdFromContactId(contactId)).toBeNull();
  });

  it('returns null conversation id for gofer/platform contacts', () => {
    expect(conversationIdFromContactId('oan:g1')).toBeNull();
    expect(conversationIdFromContactId('oan:platform')).toBeNull();
  });
});
