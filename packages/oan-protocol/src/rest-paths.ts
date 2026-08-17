/**
 * OAN REST endpoint path table (see the OAN protocol document, openagentnetwork.ai/docs).
 * Every path is joined onto basePath (/api/v1); endpoints with path parameters are
 * exported as functions that take the parameters and return the concrete path, so
 * consumers never hand-assemble strings and get them wrong.
 */
export const OAN_REST_PATHS = {
  /** Shared prefix for all OAN endpoints; the actual request path = basePath + the relative path */
  basePath: '/api/v1',

  auth: {
    /** POST, body {idToken} → {token(JWT realm=oan), user} */
    googleLogin: '/auth/oan/google',
    /** POST, body {email}, sends a verification code */
    emailRequestCode: '/auth/oan/email/request-code',
    /** POST, body {email, code} → {token, user} (login and signup combined) */
    emailVerify: '/auth/oan/email/verify',
    /** POST, requires OAN JWT auth → {code, expiresAt} */
    pairingCodes: '/auth/oan/pairing-codes',
    /** POST, body {code} → {apiKey plaintext one-time, userId} */
    pairingCodesRedeem: '/auth/oan/pairing-codes/redeem',
  },

  apiKeys: {
    /** GET, this account's API key metadata list (names/timestamps, never any key material) */
    list: '/api-keys',
    /** DELETE, revokes (deletes) one of this account's API keys → 204 */
    revoke: (apiKeyId: string) => `/api-keys/${apiKeyId}`,
  },

  /** GET, query {since?, limit?} → OanEventEnvelope[] */
  events: '/events',
  /** GET → {seq: string}, this account's current max event seq ("0" when there are no events); used by new connectors to initialize the cursor on first connect */
  eventsCursor: '/events/cursor',
  /** GET → OanUnresolvedDigest: items on this account still awaiting a user answer (re-fetch surface of raw event envelopes); used by new connectors for takeover triage */
  eventsUnresolved: '/events/unresolved',

  gofers: {
    /** POST, body {locale?, humanReviewTriggers?} → {goferId, chatId, greeting, webUrl?} */
    create: '/gofers',
    /** GET, this account's Gofer list */
    list: '/gofers',
    /** POST, body {content} → 202 {accepted:true} */
    chatMessages: (goferId: string) => `/gofers/${goferId}/chat/messages`,
    /** GET, query {since?}, role-chat history */
    chatMessagesHistory: (goferId: string) => `/gofers/${goferId}/chat/messages`,
    /** DELETE, deletes one of this account's Gofers (irreversible; cascades to its conversations and match data) → {deleted:true, goferId} */
    delete: (goferId: string) => `/gofers/${goferId}`,
    /** POST, multipart document upload (field name file, 10MB cap, same MIME allowlist as the app) → 201 AttachmentUploadResult */
    attachments: (goferId: string) => `/gofers/${goferId}/attachments`,
    /** POST, multipart image upload (field name file, 10MB cap, same MIME allowlist as the app) → 201 { photo } */
    photos: (goferId: string) => `/gofers/${goferId}/photos`,
    /** GET, query {limit?}, summary cards of all this Gofer's pairings (allowlisted projection, newest first) */
    pairings: (goferId: string) => `/gofers/${goferId}/pairings`,
    /** GET, summary card detail of one of this Gofer's pairings (same allowlisted projection; 404 when the row does not exist) */
    pairingDetail: (goferId: string, threadId: string) => `/gofers/${goferId}/pairings/${threadId}`,
  },

  threads: {
    /** GET, thread list */
    list: '/threads',
    /** GET, single thread */
    detail: (threadId: string) => `/threads/${threadId}`,
    /** GET, messages within a thread (transcript) */
    messages: (threadId: string) => `/threads/${threadId}/messages`,
    /** POST, pairing confirmation */
    pairConfirm: (threadId: string) => `/threads/${threadId}/pair/confirm`,
    /** GET, pairing-scoped attachment fetch: short-lived signed download URL for the counterpart role's attachment on this thread (no message-level lookup) → { url: string, expiresAt: number }; 404 when the attachment was deleted or no longer belongs to the counterpart */
    counterpartAttachmentUrl: (threadId: string, attachmentId: string) =>
      `/threads/${threadId}/counterpart-attachments/${attachmentId}/url`,
  },

  matchRequests: {
    /** POST, creates a match request */
    create: '/match-requests',
    /** POST, body {accept:boolean}, accepts/rejects a match request */
    decision: (matchRequestId: string) => `/match-requests/${matchRequestId}/decision`,
  },

  conversations: {
    /** GET/POST, messages on the post-match direct channel */
    messages: (conversationId: string) => `/conversations/${conversationId}/messages`,
    /** POST, multipart attachment upload (field name file, query {kind?, width?, height?}) → 201 { attachment } */
    attachments: (conversationId: string) => `/conversations/${conversationId}/attachments`,
    /** GET, redeems a short-lived signed download URL for an attachment → { url }; 404 when the attachment was deleted */
    attachmentUrl: (conversationId: string, attachmentId: string) =>
      `/conversations/${conversationId}/attachments/${attachmentId}/url`,
  },
} as const;
