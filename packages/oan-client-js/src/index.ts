// Public exports of @openagentnetwork/client-js: OanClient (connect / reconnect backfill /
// event listening) + standalone per-endpoint-family functions (callable without an instance,
// for login / pairing-code redemption flows that hold no credentials yet) + error/envelope types.
export { OanClient, type OanClientOptions, type OanClientCredentials, type OanClientStopReason } from './client.js';

export { OanApiError, OanProtocolError } from './errors.js';
export { decodeEnvelope, type OanProtocolWarning } from './envelope.js';
// oanRequest/oanRequestMultipart are "escape hatch" exports: the protocol path table
// (OAN_REST_PATHS) covers more surface than the SDK's typed wrappers, so use these to call
// endpoints the SDK has not wrapped while keeping the auth headers and the OanApiError contract
// consistent — do not hand-write fetch outside the SDK to replicate this logic
export { oanRequest, oanRequestMultipart, type AuthMode } from './rest-client.js';

export {
  googleLogin,
  requestEmailCode,
  verifyEmail,
  createPairingCode,
  redeemPairingCode,
  type OanConnectorPlatform,
  type OanUser,
  type OanLoginResult,
} from './auth.js';

export {
  createGofer,
  listGofers,
  sendGoferMessage,
  getGoferChatMessages,
  deleteGofer,
  type OanGoferCreateResult,
  type OanGoferListItem,
  type OanGoferChatMessage,
} from './gofers.js';

export {
  createMatchRequest,
  decideMatchRequest,
  type OanMatchCounterpart,
  type OanMatchStatusResult,
  type OanMatchDecisionResult,
} from './match-requests.js';

export {
  sendConversationMessage,
  getConversationMessages,
  type OanConversationMessage,
  type OanConversationAttachment,
} from './conversations.js';

export {
  uploadGoferAttachment,
  uploadGoferPhoto,
  uploadConversationAttachment,
  getConversationAttachmentUrl,
  getThreadCounterpartAttachmentUrl,
  type OanUploadFile,
  type OanRagStatus,
  type OanRoleAttachment,
  type OanAttachmentUploadResult,
  type OanGoferPhoto,
} from './attachments.js';

export { listApiKeys, revokeApiKey, type OanApiKeyMeta } from './api-keys.js';

export { listEventsSince, getEventsCursor, listUnresolvedEvents } from './events.js';

// Protocol-layer constants/types re-exported directly, so callers need no separate dependency on @openagentnetwork/protocol
export {
  OAN_PROTOCOL_VERSION,
  OAN_WS_NAMESPACE,
  OAN_WS_EVENT,
  OAN_REST_PATHS,
  OAN_EVENT_TYPES,
  OAN_MESSAGE_SOURCES,
  OAN_CONNECTOR_PLATFORMS,
  OAN_CONNECTOR_RELEASES,
  OAN_EVENTS_MAX_PAGE_LIMIT,
  type OanClientInfo,
  type OanEventEnvelope,
  type OanEventType,
  type OanMessageSource,
  type OanUnresolvedDigest,
  type OanUnresolvedSummary,
} from '@openagentnetwork/protocol';
