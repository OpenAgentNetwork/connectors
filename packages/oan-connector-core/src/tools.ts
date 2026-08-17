// OAN tools (platform-neutral): establishing a network presence is a first-class agent
// capability, not something the agent improvises with raw REST calls from memory. The channel
// itself only covers the loop "Gofer speaks → contact thread / agent replies → back to OAN";
// creating a Gofer and taking stock of existing ones happen before that loop exists — no
// contact thread is available yet — so they are exposed as standalone tools.
//
// Ongoing conversation with a Gofer is not handled here: that path is covered by the outbound
// route (send-text.ts), which includes decision routing (yes/no → match/pair decision
// endpoints). Tool results explicitly hand the contact-thread address back to the agent.
//
// Host-specific concerns are injected rather than encoded here:
// - The host's tool object shape stays in the adapter: this module produces OanToolSpec
//   (string-only parameter declarations + run returning a plain string), which the adapter
//   compiles into the host's own tool shape;
// - Host operational guidance (how to pair / recover / restart) and the idle-turn sentinel
//   convention are injected via OanHostHints;
// - The per-result character budget is injected via deps.toolResultBudget.
import {
  createGofer as createGoferApi,
  deleteGofer as deleteGoferApi,
  getGoferChatMessages as getGoferChatMessagesApi,
  listGofers as listGofersApi,
  sendGoferMessage as sendGoferMessageApi,
  type AuthMode,
} from '@openagentnetwork/client-js';
import { contactIdForGofer } from './contact-id.js';
import type { OanConnectionStatusSnapshot } from './connection.js';

/** oan_inbox item view (the tool-facing projection of an inbox-store entry) */
export interface OanInboxItemView {
  eventId: string;
  contactId: string;
  kind: 'message' | 'decision' | 'event';
  body: string;
  mediaPaths?: string[];
  receivedAt: string;
}

/** Paired connection credentials (read from the adapter's own config/credential store and injected) */
export interface OanToolCredentials {
  baseUrl: string;
  apiKey: string;
}

/**
 * Platform-neutral tool declaration: the host adapter compiles it into the host's own tool
 * object shape. All parameters are strings (the lowest common denominator across hosts), and
 * run returns plain text (multiple segments joined by newlines).
 */
export interface OanToolSpec {
  name: string;
  description: string;
  parameters: Record<string, { type: 'string'; description: string; required?: true }>;
  run(args: Record<string, string | undefined>): Promise<string>;
}

/**
 * Injection slots for host operational guidance. Every "what to do on the host" instruction in
 * tool copy (pairing command, restart procedure, idle-turn sentinel convention) comes from
 * here — the core encodes no host CLI or protocol knowledge.
 */
export interface OanHostHints {
  /** Host guidance for "not paired yet" (used by oan_status and requireCredentials copy); a full sentence */
  howToPair: string;
  /** Recovery-path guidance for an already-redeemed key (pairing code consumed but credentials never persisted); a full sentence; optional */
  howToRecover?: string;
  /** Host restart guidance for a stalled connection: an imperative fragment embedded after "Otherwise …" (e.g. 'restart the gateway once'); defaults to a neutral fragment */
  howToRestart?: string;
  /** Host steps for updating an already-installed connector, handed to the user when a connector_outdated notice arrives (see the skill's "Staying current"); defaults to neutral wording */
  howToUpdate?: string;
  /** The host's "nothing to do" sentinel convention (closing rule of oan_inbox results); a full sentence; defaults to neutral wording */
  idleSentinel?: string;
}

export interface OanCoreToolDeps {
  /** Read the currently effective connection credentials; returns undefined when not paired */
  readCredentials: () => OanToolCredentials | undefined;
  /** In-process status snapshot of the active connection; undefined when the connection is not running in this process (used by oan_status) */
  readConnectionStatus?: () => OanConnectionStatusSnapshot | undefined;
  /**
   * Cold-instance fallback: read the connection liveness record the connector runtime persists
   * to disk (liveness-store). When the in-process snapshot is not observable, "the runtime
   * confirmed the connection alive N seconds ago" is the only source of truth that can answer
   * "are we actually connected" across instances.
   */
  readConnectionLiveness?: () => Promise<{ record: { state: 'connected' | 'stopped'; baseUrl?: string; lastAliveAt: string; stoppedReason?: string }; fresh: boolean } | undefined>;
  createGofer?: typeof createGoferApi;
  listGofers?: typeof listGofersApi;
  sendGoferMessage?: typeof sendGoferMessageApi;
  deleteGofer?: typeof deleteGoferApi;
  getGoferChatMessages?: typeof getGoferChatMessagesApi;
  /**
   * Registration path for oan_ask_user (implemented by the adapter): records the protocol-level
   * fact "this contact's question has been escalated to the user" in the ledger, driving the
   * reminder branch. The question itself is relayed by the agent in its own words in the turn
   * output — the turn text is the user-visible surface; the tool only records the fact.
   */
  markEscalated?: (contactId: string) => boolean;
  /**
   * Return path for oan_reply: deliver a message to a Gofer contact (implemented by the
   * adapter — the connector performs the delivery itself). via: connection = through the active
   * connection (including pending-decision routing and ledger settlement); rest = direct REST
   * using stored credentials.
   */
  deliverToContact?: (contactId: string, text: string) => Promise<{ via: 'connection' | 'rest' }>;
  /**
   * Read surface for oan_inbox (the adapter resolves the inbox file path): fetch pending items
   * and consume them on fetch (fetch = consume; the fact that a reply is owed is tracked
   * separately and persistently by the ledger — consuming an item does not settle it).
   */
  fetchInbox?: () => Promise<OanInboxItemView[]>;
  consumeInbox?: (eventIds: string[]) => Promise<void>;
  /**
   * Cross-session file delivery (wired by the adapter; can bind directly to sendOanFile in the
   * core's media.ts): files handed over by the user are delivered to the Gofer as real
   * attachments through this — never allowed to degrade into a text summary (a hard rule of
   * the skill).
   */
  deliverFileToContact?: (contactId: string, filePath: string, caption?: string) => Promise<{ fileName: string }>;
  /**
   * Character budget for a single tool result (a host contract; must be injected): hosts differ
   * in how they truncate or replace oversized tool results (some replace the whole result with
   * a generic "elided" note that carries no continuation hint), so the core truncates within
   * this budget itself and provides its own continuation instructions.
   */
  toolResultBudget: number;
  /** Host operational guidance slots (see OanHostHints) */
  hostHints: OanHostHints;
}

export function createOanTools(deps: OanCoreToolDeps): OanToolSpec[] {
  return [
    statusTool(deps),
    createGoferTool(deps),
    listGofersTool(deps),
    goferHistoryTool(deps),
    deleteGoferTool(deps),
    inboxTool(deps),
    askUserTool(deps),
    replyTool(deps),
  ];
}

/** Per-call item cap for oan_inbox: together with toolResultBudget, keeps a single result under the host's tool-result limit */
const INBOX_PAGE_LIMIT = 12;

/** Default neutral "nothing to do" closing rule: names no host-specific sentinel */
const DEFAULT_IDLE_SENTINEL =
  'An idle end of turn is only valid after every item has its disposition: if any item went to your user, ' +
  "this turn's reply is that ask or brief; only when every item was answered to its Gofer may the turn end " +
  'with nothing further — never leave the turn empty.';

/** Default neutral restart fragment, embedded after "Otherwise …" */
const DEFAULT_RESTART_FRAGMENT = 'restart the connector runtime once';

/**
 * oan_inbox: the inbox read surface — Gofer messages never enter any host session, so this is
 * the only way the agent ever sees them. Consume-on-fetch: items already returned never appear
 * again; "who is owed a reply" is tracked and chased independently by the ledger, so fetching
 * an item does not count as replying to it.
 */
function inboxTool(deps: OanCoreToolDeps): OanToolSpec {
  return {
    name: 'oan_inbox',
    description:
      'Fetch pending items from your OpenAgentNetwork inbox: messages and questions from your user\'s Gofers, ' +
      'match/pair decision requests, and network events. Call this whenever a system note says OAN items are ' +
      'pending. Every item must end in reply-or-escalate before you end the turn: (A) reply via oan_reply with ' +
      'what your user actually stated, or (B) bring it to your user — relay (in your own words, naming the ' +
      'Gofer) anything that needs their input and register it with oan_ask_user; give a short brief for any item ' +
      'you did not reply to. "No action needed / just context" is not a disposition. kind=decision items need ' +
      'your user\'s yes/no unless they explicitly pre-authorized you to decide. Items are consumed on fetch and ' +
      'will not repeat — dispose of everything this call returns.',
    parameters: {},
    run: async () => {
      if (!deps.fetchInbox) {
        return text('The inbox is not available in this session (channel not running). Check oan_status.');
      }
      const items = await deps.fetchInbox();
      if (items.length === 0) {
        return text('No pending OAN items. Nothing to do.');
      }
      const page = items.slice(0, INBOX_PAGE_LIMIT);
      try {
        await deps.consumeInbox?.(page.map((item) => item.eventId));
      } catch {
        // A failed consume mark at worst returns the same items once more next call; item
        // handling itself is idempotent (the agent deduplicates oan_reply)
      }
      const lines = page.map((item) => {
        const media = item.mediaPaths?.length
          ? ` [attachments: ${item.mediaPaths.join(', ')}]`
          : '';
        return `- [${item.kind}] from ${item.contactId} at ${item.receivedAt}:${media}\n  ${item.body.replace(/\n/g, '\n  ')}`;
      });
      const remainder = items.length - page.length;
      const tail = remainder > 0 ? `\n(${remainder} more pending — call oan_inbox again after handling these.)` : '';
      // The closing rule (the host's sentinel convention) comes from hostHints; neutral by default
      const idleSentinel = deps.hostHints.idleSentinel ?? DEFAULT_IDLE_SENTINEL;
      return text(
        `${page.length} pending ${page.length === 1 ? 'item' : 'items'}:\n${lines.join('\n')}${tail}\n` +
          'Dispose of each item now — reply-or-escalate, no third option: reply via oan_reply where your user\'s ' +
          'stated facts suffice; otherwise bring it to your user — relay to your user what needs them (then ' +
          'oan_ask_user to register it), and brief them in a line on any item you did not reply to; decisions ' +
          'need your user\'s yes/no unless they explicitly pre-authorized you to decide. "Just context / no ' +
          `action needed" is not a disposition, and these items will not be shown again. ${idleSentinel}`,
      );
    },
  };
}


/**
 * oan_reply: the only channel that delivers a message to a Gofer contact. oan: contacts exist
 * solely inside the connector's delivery system — the host's own messaging facilities have no
 * route to such targets — so the connector performs the delivery itself (through the active
 * connection with pending-decision routing and ledger settlement, or via direct REST on a cold
 * instance). The copy stays host-neutral: it names no host tool, only states the connector's
 * own fact that this tool is the sole reachable route.
 */
function replyTool(deps: OanCoreToolDeps): OanToolSpec {
  return {
    name: 'oan_reply',
    description:
      "Deliver a message to one of your user's Gofers on OpenAgentNetwork — the only way to answer inbox items " +
      'and send anything to a Gofer. Also works for oan:conv:<id> direct-conversation contacts. No other tool ' +
      'and no raw API call reaches an oan: contact; this tool is the only route that does. ' +
      'Everything you send is recorded on the conversation page your user can read.',
    parameters: {
      contactId: {
        type: 'string',
        description: 'The target contact: oan:<goferId> (its profile chat) or oan:conv:<conversationId>.',
        required: true,
      },
      message: {
        type: 'string',
        description: 'The message to deliver, exactly as it should reach the Gofer.',
        required: true,
      },
      filePath: {
        type: 'string',
        description:
          'Absolute path to a file your user provided (e.g. a document in your workspace) to deliver as a real ' +
          'attachment alongside the message. Use this whenever your user hands over a file — never summarize a ' +
          'file in place of sending it. Accepted: pdf, doc, docx, txt, csv, jpg, png, webp; up to 10MB.',
      },
    },
    run: async (args) => {
      const target = args.contactId?.trim();
      const content = args.message?.trim();
      if (!target || !content) {
        throw new Error('Both contactId and message are required.');
      }
      const normalized = target.startsWith('oan:') ? target : contactIdForGofer(target);
      const attachmentPath = args.filePath?.trim();
      if (attachmentPath) {
        if (!deps.deliverFileToContact) {
          throw new Error('File delivery is not wired up in this session. Retry in a moment, and check oan_status.');
        }
        const { fileName } = await deps.deliverFileToContact(normalized, attachmentPath, content);
        return text(
          `Delivered "${fileName}" to ${normalized} as a real attachment (with your message as its caption). ` +
            'The Gofer can quote its content in network conversations.',
        );
      }
      if (!deps.deliverToContact) {
        throw new Error('Delivery is not wired up in this session. Retry in a moment, and check oan_status.');
      }
      await deps.deliverToContact(normalized, content);
      return text(
        `Delivered to ${normalized}. It is archived on the conversation page your user can read. ` +
          'Do not resend it or use any other delivery path.',
      );
    },
  };
}

/**
 * oan_ask_user (a thin layer): presenting the question is done by the agent in its own words
 * in the turn output — the turn text is the user-visible surface, so no cross-session delivery
 * is needed. The tool only records the protocol-level fact ("this contact's question has been
 * escalated to the user"), which drives the ledger's reminder wording and guarantees the
 * question is not forgotten while the user has not answered.
 */
function askUserTool(deps: OanCoreToolDeps): OanToolSpec {
  return {
    name: 'oan_ask_user',
    description:
      "Register that a Gofer's question has been relayed to your user. Call this right after you put the " +
      'question to your user in your own words in your reply (always name which Gofer is asking) — the ' +
      'registration drives reminder bookkeeping so the question is never lost. When your user answers, deliver ' +
      'it with the oan_reply tool — no other tool reaches oan: contacts.',
    parameters: {
      goferId: {
        type: 'string',
        description: 'The Gofer whose question needs your user — its oan:<goferId> contact id or bare goferId.',
        required: true,
      },
      question: {
        type: 'string',
        description: 'The question exactly as the Gofer asked it, with minimal context if needed.',
        required: true,
      },
    },
    run: async (args) => {
      const targetGofer = args.goferId?.trim();
      const targetQuestion = args.question?.trim();
      if (!targetGofer || !targetQuestion) {
        throw new Error('Both goferId and question are required.');
      }
      const contactId = targetGofer.startsWith('oan:') ? targetGofer : contactIdForGofer(targetGofer);
      const registered = deps.markEscalated?.(contactId) ?? false;
      const bookkeeping = registered
        ? 'Registered — reminders will track this until the answer is delivered.'
        : 'Registration skipped (channel not running here); the pending-reply ledger will still remind you.';
      return text(
        `${bookkeeping} Make sure your current reply asks your user the question in your own words and names ` +
          `the Gofer it came from. When they answer, deliver it with the oan_reply tool (contactId: ${contactId}).`,
      );
    },
  };
}

/**
 * oan_gofer_history: fetch a Gofer's full two-sided conversation record (server-side archive,
 * account-scoped). Rationale: the event stream carries only the Gofer's side (what the
 * connector itself sent does not flow back as events), and a fresh connector starts from "now"
 * without replaying history — so after swapping in a new instance on the same account, this
 * server-side record is the only source of the full context for resuming a conversation with
 * an existing Gofer, including what the previous instance already said.
 */
function goferHistoryTool(deps: OanCoreToolDeps): OanToolSpec {
  const getMessages = deps.getGoferChatMessages ?? getGoferChatMessagesApi;

  return {
    name: 'oan_gofer_history',
    description:
      "Fetch the full two-sided conversation record of one of your user's Gofers from the network's archive — " +
      'both what the Gofer said and what your side (including any previous instance on this account) already told it. ' +
      'Call this before answering a Gofer you have no context for, so you neither contradict nor repeat what was already said.',
    parameters: {
      goferId: {
        type: 'string',
        description: 'The Gofer whose conversation to fetch, as listed by oan_list_gofers.',
        required: true,
      },
      since: {
        type: 'string',
        description: 'ISO-8601 timestamp; only messages after this moment. Omit for the recent page.',
      },
    },
    run: async (args) => {
      const target = args.goferId?.trim();
      if (!target) {
        throw new Error('goferId is required — call oan_list_gofers to find it.');
      }
      const { baseUrl, auth } = requireCredentials(deps);
      const messages = await getMessages(baseUrl, auth, target, args.since?.trim() || undefined);
      if (messages.length === 0) {
        return text(`No recorded conversation for Gofer ${target}${args.since ? ` since ${args.since}` : ''}.`);
      }
      // Host truncation of oversized tool results is out of our control (some hosts replace
      // the whole result with a generic "elided" note carrying no continuation hint) — so trim
      // from the head within the injected toolResultBudget and spell out how to continue via `since`
      const lines = messages.map((message) => `[${message.createdAt}] ${labelForRole(message.role)}: ${message.content}`);
      const { kept, dropped } = fitWithinToolResultBudget(lines, deps.toolResultBudget);
      const continuation = dropped > 0
        ? `NOTE: ${dropped} earlier message(s) omitted to fit the tool-result limit. The record above starts at the oldest shown timestamp; ` +
          `to read older history, call this tool again with \`since\` set just before that timestamp.`
        : '';
      return text(
        `Conversation record for Gofer ${target} (${messages.length} messages; "your side" includes previous instances on this account):`,
        ...kept,
        continuation,
      );
    },
  };
}

/** Keep lines from the tail (newest messages) backwards until the budget runs out — the freshest context always wins over the oldest */
function fitWithinToolResultBudget(lines: string[], budget: number): { kept: string[]; dropped: number } {
  let total = 0;
  const kept: string[] = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    total += lines[i].length + 1;
    if (total > budget && kept.length > 0) {
      return { kept, dropped: i + 1 };
    }
    kept.unshift(lines[i]);
  }
  return { kept, dropped: 0 };
}

/** Message role → readable label: user = the connector side (this account's agent, including previous instances), assistant = the Gofer itself */
function labelForRole(role: 'user' | 'assistant' | 'system'): string {
  if (role === 'assistant') return 'Gofer';
  if (role === 'user') return 'Your side';
  return 'System';
}

/**
 * oan_status: answers "am I paired, is the channel connected, are events arriving". Never
 * throws — this tool exists precisely to diagnose failure states, so every state is reported
 * as plain text (hardened against a real-world failure where the agent could only dig through
 * runtime logs to guess the connection state, looping through status/logs/config forever).
 */
function statusTool(deps: OanCoreToolDeps): OanToolSpec {
  const restartFragment = deps.hostHints.howToRestart ?? DEFAULT_RESTART_FRAGMENT;
  return {
    name: 'oan_status',
    description:
      'Report the OpenAgentNetwork connector state: whether this instance is paired, whether it holds a live ' +
      'connection, and how many events have arrived. Call this to verify the connection after pairing or a ' +
      'restart instead of reading logs.',
    parameters: {},
    run: async () => {
      const credentials = deps.readCredentials();
      if (!credentials) {
        // The host's pairing guidance is injected via hostHints; the core encodes no host CLI knowledge
        return text('NOT PAIRED. No OAN credentials are configured for this connector.', deps.hostHints.howToPair);
      }

      const status = deps.readConnectionStatus?.();
      if (!status) {
        // This tool may run outside the process holding the connection, where the in-process
        // connection object is invisible — so first read the liveness record the runtime wrote
        // to disk (the cross-instance source of truth) and give an authoritative answer whenever
        // possible, instead of saying "not observable" (observed in production: "not observable"
        // gets relayed as "not connected yet", and the user waits forever on a connection that
        // was established long ago)
        const liveness = await deps.readConnectionLiveness?.();
        if (liveness?.record.state === 'connected' && liveness.fresh) {
          const ageSec = Math.max(0, Math.round((Date.now() - Date.parse(liveness.record.lastAliveAt)) / 1000));
          return text(
            `CONNECTED to ${liveness.record.baseUrl ?? credentials.baseUrl}. The connector runtime confirmed the ` +
              `connection alive ${ageSec}s ago (liveness record; this tool call runs outside the process that ` +
              'holds the connection, which is why the in-process snapshot is not visible — that is normal).',
            'Everything is working. Tell your user the connection is up.',
          );
        }
        if (liveness?.record.state === 'stopped') {
          return text(
            `PAIRED to ${credentials.baseUrl}, but the connector runtime recorded the connection as STOPPED (${liveness.record.stoppedReason ?? 'unknown reason'}).`,
            `If the reason indicates 401/unauthorized, the API key was revoked — re-pair with a fresh pairing code. Otherwise ${restartFragment}.`,
          );
        }
        return text(
          `PAIRED to ${credentials.baseUrl}. No channel connection is observable from this process — either a ` +
            'pending configuration reload has not fired yet, or this tool call is running outside the process ' +
            'that holds the connection while the connection itself is fine.',
          'Do NOT restart anything based on this alone, and do NOT tell your user the channel is disconnected — ' +
            'you cannot know that from here. End your turn now; the connector posts a status note when it ' +
            '(re)connects, and polling this tool is what delays a pending reload. ' +
            `Only if events are clearly not arriving across later turns, ${restartFragment} — never kill the process yourself.`,
        );
      }
      if (status.stoppedReason) {
        return text(
          `PAIRED to ${credentials.baseUrl}, but the connection STOPPED (${status.stoppedReason}).`,
          status.lastErrorMessage ? `Last error: ${status.lastErrorMessage}` : '',
          `If the error indicates 401/unauthorized, the API key was revoked — re-pair with a fresh pairing code. Otherwise ${restartFragment}.`,
        );
      }
      if (!status.connected) {
        return text(
          `PAIRED to ${credentials.baseUrl}; the channel is starting or reconnecting (not connected yet).`,
          status.lastErrorMessage ? `Last error: ${status.lastErrorMessage}` : '',
          'Wait a few seconds and call this tool again.',
        );
      }
      return text(
        `CONNECTED to ${credentials.baseUrl}.`,
        status.eventCount > 0
          ? `Events received since this connector started: ${status.eventCount} (last at ${status.lastEventAt}).`
          : 'No events received yet — normal for an account whose Gofers have nothing new to say. The connection is live.',
      );
    },
  };
}

function createGoferTool(deps: OanCoreToolDeps): OanToolSpec {
  const createGofer = deps.createGofer ?? createGoferApi;
  const sendGoferMessage = deps.sendGoferMessage ?? sendGoferMessageApi;

  return {
    name: 'oan_create_gofer',
    description:
      'Create a Gofer on OpenAgentNetwork to pursue one goal your user has stated, and open its profile chat with that goal. ' +
      'Only call this after your user has told you what they want to accomplish through other people and what they offer — ' +
      "the goal's own substance (the thing they provide, or what makes them a genuine counterparty), not an extra inducement — " +
      'never to explore whether they might want something. Each distinct task is its own Gofer — when your user brings several ' +
      'independent tasks at once, call this tool once per task, each with only that task\'s own goal statement. The reason is ' +
      'mechanical: the network matches each Gofer as a single identity against counterparts, so tasks that would be pursued ' +
      'with different counterparts (each can succeed or fail on its own) must not share a Gofer — a bundled profile blurs the ' +
      'matching identity and every task in it matches worse. Bundle only what a single counterpart would engage with as a whole.',
    parameters: {
      goal: {
        type: 'string',
        description:
          'The goal your user stated, in their own words: what they want to find or accomplish through other people.',
        required: true,
      },
      offer: {
        type: 'string',
        description:
          "What your user offers, as they described it — the goal's own substance: the thing they " +
          'provide, or what makes them a genuine counterparty. Not a separate inducement; do not ' +
          'ask for or invent one.',
      },
      locale: {
        type: 'string',
        description: 'BCP-47 locale for the Gofer conversation, e.g. "en" or "zh-CN".',
      },
    },
    run: async (args) => {
      const statedGoal = args.goal?.trim();
      if (!statedGoal) {
        throw new Error(
          'A Gofer carries one goal. Ask your user what they want to accomplish through other people, then call this again with their answer as `goal`.',
        );
      }

      const { baseUrl, auth } = requireCredentials(deps);
      const locale = args.locale?.trim();
      const gofer = await createGofer(baseUrl, auth, locale ? { locale } : {});
      const opening = args.offer?.trim()
        ? `What I'm looking for: ${statedGoal}\nWhat I can offer: ${args.offer.trim()}`
        : `What I'm looking for: ${statedGoal}`;
      // Send the goal statement immediately after creation: the server persists the greeting
      // at create time (the create response carries it), so the web timeline is always
      // "greeting → goal statement". Never defer the goal's delivery to "some later turn that
      // processes the inbox" — on a host with heartbeats disabled that turn may never come
      // (hardened against a real-world failure)
      await sendGoferMessage(baseUrl, auth, gofer.goferId, opening);

      return text(
        `Gofer ${gofer.goferId} created.`,
        `Its profile chat was opened with the stated goal (the Gofer's greeting precedes it on the record). ` +
          `Its follow-ups will arrive as inbox items (contact ${contactIdForGofer(gofer.goferId)}) — the greeting itself ` +
          `needs no reply to the Gofer; a one-line brief to your user covers it. Continue the profile conversation via ` +
          `oan_inbox/oan_reply, answering from what you actually know about your user (ask them when you do not know).`,
        gofer.webUrl
          ? `Tell your user they can watch the full conversation with this Gofer (its questions and everything your side shares) at: ${gofer.webUrl} — ` +
            'give them this link now.'
          : '',
      );
    },
  };
}

function listGofersTool(deps: OanCoreToolDeps): OanToolSpec {
  const listGofers = deps.listGofers ?? listGofersApi;

  return {
    name: 'oan_list_gofers',
    description:
      "List the Gofers your user already has on OpenAgentNetwork, with each one's contact id. " +
      'Use it before creating a Gofer to check whether one already covers the goal.',
    parameters: {},
    run: async () => {
      const { baseUrl, auth } = requireCredentials(deps);
      const gofers = await listGofers(baseUrl, auth);
      if (gofers.length === 0) {
        return text('No Gofer exists on this account yet.');
      }
      return text(
        ...gofers.map((gofer) =>
          [
            `${gofer.goferId} — ${gofer.name || '(unnamed)'} [${gofer.discoveryStatus}] — contact ${contactIdForGofer(gofer.goferId)}`,
            gofer.webUrl ? `conversation page (share with your user): ${gofer.webUrl}` : '',
            gofer.description || '',
          ]
            .filter(Boolean)
            .join('\n'),
        ),
      );
    },
  };
}

function deleteGoferTool(deps: OanCoreToolDeps): OanToolSpec {
  const deleteGofer = deps.deleteGofer ?? deleteGoferApi;

  return {
    name: 'oan_delete_gofer',
    description:
      "Permanently delete one of your user's Gofers on OpenAgentNetwork, ending its conversations and matching. " +
      'Irreversible — only call this when your user explicitly asked to remove it, or confirmed after you proposed it ' +
      '(e.g. its goal is done or abandoned). Use oan_list_gofers first to identify the right goferId.',
    parameters: {
      goferId: {
        type: 'string',
        description: 'The Gofer to delete, as listed by oan_list_gofers.',
        required: true,
      },
    },
    run: async (args) => {
      const target = args.goferId?.trim();
      if (!target) {
        throw new Error('goferId is required — call oan_list_gofers to find it.');
      }
      const { baseUrl, auth } = requireCredentials(deps);
      await deleteGofer(baseUrl, auth, target);
      return text(
        `Gofer ${target} deleted. Contact "${contactIdForGofer(target)}" will produce no further inbox items.`,
      );
    },
  };
}

function requireCredentials(deps: OanCoreToolDeps): { baseUrl: string; auth: AuthMode } {
  const credentials = deps.readCredentials();
  if (!credentials) {
    // Pairing/recovery guidance is injected via hostHints, so no host CLI copy lives here
    const recover = deps.hostHints.howToRecover ? ` ${deps.hostHints.howToRecover}` : '';
    throw new Error(`OpenAgentNetwork is not paired yet. ${deps.hostHints.howToPair}${recover}`);
  }
  return { baseUrl: credentials.baseUrl, auth: { kind: 'apiKey', apiKey: credentials.apiKey } };
}

/** Join multiple text segments (dropping empty lines) into a plain string */
function text(...lines: string[]): string {
  return lines.filter(Boolean).join('\n');
}
