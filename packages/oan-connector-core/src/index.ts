// Public exports of @openagentnetwork/connector-core: the platform-neutral core of an OAN
// connector. Layering principle: no host package is ever imported; host contracts
// (configuration shapes, tool-result budgets, restart semantics, sentinel wording) are always
// injected as parameters by the adapter layer. An adapter only implements the host wiring:
// tool registration, the wake mechanism, file IO, and credential storage.

// ---- Contact IDs and decision intent ----
export {
  contactIdForGofer,
  contactIdForConversation,
  contactIdForEnvelope,
  conversationIdFromContactId,
  goferIdFromContactId,
  PLATFORM_CONTACT_ID,
} from './contact-id.js';
export { parseDecisionIntent } from './decision-intent.js';

// ---- Inbound: event mapping → inbox staging → wake requests ----
export {
  mapEnvelopeToInboundMessage,
  attachmentDisplayName,
  DEFAULT_IDLE_EXIT_PHRASE,
  type InboundMediaRef,
  type InboundMessageDraft,
  type OanInboundContractOptions,
} from './inbound-mapping.js';
export {
  intakeInboundDraft,
  shouldWakeAgent,
  type InboundIntakeDeps,
  type OanAutoReplyMode,
} from './inbound-dispatch.js';
export {
  stageInboxItem,
  listPendingInboxItems,
  countPendingInboxItems,
  markInboxItemsHandled,
  pruneHandledInboxItems,
  type OanInboxItem,
} from './inbox-store.js';

// ---- Outbound: routing → delivery → settlement ----
export { PendingReplyTracker, routeOutbound, type RoutedOutboundAction } from './outbound-router.js';
export { sendOanText } from './send-text.js';
export { settleOutbound, syntheticMessageId, type OanOutboundSettlement } from './outbound-completion.js';
export { confirmPairing } from './thread-pair-confirm.js';

// ---- Connection lifecycle: connection wrapper + indefinitely-reconnecting supervision loop ----
export {
  OanConnection,
  type OanConnectionHandle,
  type OanConnectionOptions,
  type OanConnectionStatusSnapshot,
} from './connection.js';
// Connector identity declared at the handshake; each adapter supplies its own name/version,
// and the release registry is what the server compares it against (adapters assert against it
// so a declared name that no registry knows — and would therefore never be notified — is caught)
export { OAN_CONNECTOR_RELEASES, type OanClientInfo } from '@openagentnetwork/client-js';
export {
  superviseOanConnection,
  isAuthDeadReason,
  type OanSupervisorOptions,
  type OanSupervisorTransition,
  type SupervisedConnection,
} from './connection-supervisor.js';
export { createFileCursorStore, type CursorStore } from './cursor-store.js';
export {
  writeLiveness,
  readLiveness,
  isLivenessFresh,
  OAN_LIVENESS_WRITE_INTERVAL_MS,
  OAN_LIVENESS_FRESH_MS,
  type OanLivenessRecord,
} from './liveness-store.js';

// ---- Durable state: pending-reply ledger / wake retry queue / one-shot advisories / takeover marker ----
export {
  PendingExchangeLedger,
  sweepPendingReminders,
  buildPendingReminderNote,
  DEFAULT_REMINDER_IDLE_EXIT_INSTRUCTION,
  type PendingExchangeEntry,
  type PendingReminderNoteOptions,
} from './pending-ledger.js';
export {
  stagePendingMainWake,
  listPendingMainWakes,
  touchPendingMainWakeAttempt,
  removePendingMainWake,
  type PendingMainWake,
} from './pending-wake-store.js';
export { claimAdvisory } from './advisory-store.js';
export { markTakeoverPending, isTakeoverPending, clearTakeoverPending } from './takeover-store.js';
export { runTakeoverIfPending, buildTakeoverNote, type TakeoverRunDeps } from './takeover.js';
export {
  OAN_MAIN_WAKE_RETRY_MS,
  OAN_MAIN_WAKE_MAX_AGE_MS,
  OAN_MAIN_WAKE_SWEEP_MS,
} from './oan-delivery-constants.js';

// ---- Joining (email flow), pairing, and first-time setup ----
export { requestJoinCode, completeJoinWithCode, type OanJoinDeps } from './join.js';
export { redeemPairingCredentials, verifyApiKeyCredentials, type OanPairedCredentials } from './pairing.js';
export { runPairingSetup, DEFAULT_BASE_URL, type SetupHostBindings } from './setup-flow.js';

// ---- Tool layer (platform-neutral declarations; the adapter compiles them into host tool shapes) ----
export {
  createOanTools,
  type OanCoreToolDeps,
  type OanHostHints,
  type OanInboxItemView,
  type OanToolCredentials,
  type OanToolSpec,
} from './tools.js';

// ---- Attachment semantics (the host injects only file IO callbacks) ----
export {
  createInboundMediaStager,
  stageOutboundAttachment,
  sendOanFile,
  mimeForFileName,
  OAN_MEDIA_MAX_BYTES,
  OAN_MEDIA_EXTENSION_MIME,
  type OanFileSendResult,
  type OanInboundMediaOptions,
  type OanInboundMediaStager,
  type OanMediaHostIo,
  type OanOutboundAttachment,
  type OanOutboundFileInput,
  type OanStagedInboundAttachment,
  type StagedInboundMedia,
} from './media.js';

// ---- Skill assembly (single source of content; host-specific passages injected via slots) ----
export { buildSkillMarkdown, type OanSkillSlots } from './skill.js';
