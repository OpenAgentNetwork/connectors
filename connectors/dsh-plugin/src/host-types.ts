// Structural types for the DSH host (type-only replicas): written verbatim from the
// harness's own type definitions; no @deepseek-ai/dsh-* package is imported at runtime. The
// host self-declares as a developer preview, so breaking changes are certain — the runtime
// coupling surface is reduced to "structural alignment + re-verifying the contracts
// document". Each type's evidence is annotated with a file:line comment (all pointing at
// deepseek-harness master@47f9438, spot-checked verbatim against the released rc.6).

// ---------------------------------------------------------------------------
// ContentBlock (packages/llm/llm/src/types.ts:50-110) — this plugin only constructs the text branch
// ---------------------------------------------------------------------------

/** TextBlock (types.ts:50-53): the only content form used by tool render and wake messages */
export interface HostTextBlock {
  type: 'text';
  text: string;
}

// ---------------------------------------------------------------------------
// ToolDefinition family (packages/llm/llm/src/types.ts:312-317 +
// packages/core/tools/src/index.ts:212-421)
// ---------------------------------------------------------------------------

/** Lossless JSON value (the constraint on ToolExecutionSuccess.value, index.ts:559) */
export type HostJsonValue = null | boolean | number | string | HostJsonValue[] | { [key: string]: HostJsonValue };

/**
 * ToolOutputDefinition (index.ts:212-288): the hard gate for raw registration — a missing
 * schema+render is a TypeError right inside register() (§2.1); successful return values are
 * strictly validated against the schema (§2.3).
 */
export interface HostToolOutputDefinition {
  readonly schema: Record<string, unknown>;
  render(args: unknown, value: HostJsonValue): HostTextBlock[];
  presentationMeta?(args: unknown, value: HostJsonValue): HostJsonValue;
}

/** Minimal ToolRunContext surface (index.ts:404-421): this plugin only passes the signal through and consumes no other member */
export interface HostToolRunContext {
  readonly signal: AbortSignal;
}

/**
 * ToolDefinition (ToolSchema types.ts:312-317 + index.ts:212-288).
 * Key contract (§2.3): the host does not validate arguments against parameters ("tools
 * validate their own schema") — execute must self-validate; parameters is the JSON Schema
 * sent to the model.
 */
export interface HostToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  readonly output: HostToolOutputDefinition;
  execute(args: unknown, exec: HostToolRunContext): Promise<unknown>;
  timeoutMs?: number;
}

/** Minimal ToolRuntime surface (index.ts:1037-1062): register returns an exact disposer, reclaimed automatically with the registrant's fiber */
export interface HostToolRuntime {
  register(definition: HostToolDefinition): () => void;
}

// ---------------------------------------------------------------------------
// Message family (packages/llm/llm/src/message.ts:100-199)
// ---------------------------------------------------------------------------

/** The MessageSource branches this plugin uses (message.ts:100-105); a plugin source may carry a ContextForm */
export type HostMessageSource =
  | { kind: 'user' }
  | { kind: 'plugin'; plugin: string; form?: 'instructions' | 'catalog' | 'relay' | 'recall' };

/**
 * UserMessage (message.ts:159-199). The host's createUserMessage is a runtime function and
 * cannot be imported; the evidence that a self-built, structurally identical object works
 * is that the inbox only checks message.id uniqueness
 * (packages/core/agent/src/inbox.ts:202-219), with no brand/frozen check; the host's own
 * convention is deepFreeze (message.ts:166-169), which self-built objects follow (see
 * buildPluginUserMessage in wake.ts).
 */
export interface HostUserMessage {
  readonly id: string;
  readonly role: 'user';
  readonly content: HostTextBlock[];
  readonly source: HostMessageSource;
}

// ---------------------------------------------------------------------------
// Minimal Agent surface (packages/core/agent/src/runtime-types.ts:64-144 + index.ts:583-617)
// ---------------------------------------------------------------------------

/** AgentStatus (runtime-types.ts:64) */
export type HostAgentStatus = 'idle' | 'running';

/** Opaque Session handle: only passed through as the argument to sessions.flush (session/src/index.ts:1022) */
export type HostSession = object;

/** Minimal per-agent scoped ctx surface: listeners on agent.ctx receive only that agent's events (scope/src/index.ts:170-181) */
export interface HostAgentContext {
  on(name: 'agent/status', listener: (payload: { agent: HostAgent; status: HostAgentStatus }) => void): () => boolean;
  on(name: 'session/event', listener: (session: HostSession, event: unknown) => void): () => boolean;
}

/** Minimal Agent surface (runtime-types.ts:64-144): followup = queue an independent turn and wake (this plugin's only delivery primitive) */
export interface HostAgent {
  readonly id: string;
  readonly session: HostSession;
  readonly status: HostAgentStatus;
  readonly ctx: HostAgentContext;
  followup(message: HostUserMessage): void;
  whenIdle(): Promise<void>;
}

/**
 * Minimal AgentRegistry surface (index.ts:583-617). roots() = existing agents with
 * owner === undefined; get is used for the reference-identity check before delivery (a
 * stale reference silently swallows the followup, sdk/server.ts:134-141).
 */
export interface HostAgentRegistry {
  get(id: string): HostAgent | undefined;
  list(): HostAgent[];
  roots(): HostAgent[];
  withoutInitiator<T>(operation: () => T): T;
}

/** Minimal SessionStore surface: flush is the persistence barrier (session/src/index.ts:1022, §3.3/§4.3) */
export interface HostSessionStore {
  flush(session: HostSession): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// credentials API (packages/credentials/credentials/src/index.ts:60-99 + types.ts:29)
// ---------------------------------------------------------------------------

/** ResolvedCredential (index.ts:66-69): "consumers re-resolve at each operation" */
export interface HostResolvedCredential {
  value: string;
  source: string;
}

/** CredentialInfo (index.ts:71-75): writable=false means shadowed by a launch-time environment variable (credentials-local §5.2) */
export interface HostCredentialInfo {
  configured: boolean;
  source?: string;
  writable: boolean;
}

/** Abstract CredentialProvider surface (index.ts:60-99); ref format /^[A-Za-z_][A-Za-z0-9_]*$/ (index.ts:16) */
export interface HostCredentialProvider {
  resolve(ref: string): Promise<HostResolvedCredential | undefined>;
  describe(ref: string): Promise<HostCredentialInfo>;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// CommandDefinition family (packages/interaction/commands/src/index.ts:28-55, types.ts:19-49)
// ---------------------------------------------------------------------------

/** CommandInvocation (index.ts:28-40): rawInput = all text after the command name (including the separating whitespace) */
export interface HostCommandInvocation {
  readonly agent: HostAgent;
  readonly rawInput: string;
  readonly signal: AbortSignal;
}

/** CommandResult (types.ts:44-49) */
export type HostCommandResult =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string };

/** CommandDefinition (index.ts:42-55): name must match /^[a-z][a-z0-9_-]*$/; recordInput=false keeps rawInput out of the event log */
export interface HostCommandDefinition {
  readonly name: string;
  readonly description: string;
  readonly input?: { readonly hint: string };
  readonly recordInput?: boolean;
  readonly handler: (invocation: HostCommandInvocation) => HostCommandResult | Promise<HostCommandResult>;
}

/** Minimal CommandRuntime surface (index.ts:245-252) */
export interface HostCommandRuntime {
  register(definition: HostCommandDefinition): () => void;
}

// ---------------------------------------------------------------------------
// SkillProvider family (packages/skill/skill/src/index.ts:39-101,240-276,391)
// ---------------------------------------------------------------------------

/** Literal value of BUNDLED_SKILL_RANK (skill/src/index.ts:74-83 comment: lower ranks win; the constant = 600) */
export const HOST_BUNDLED_SKILL_RANK = 600;

/** SkillInvocationPolicy (within index.ts:60-63) */
export interface HostSkillInvocationPolicy {
  readonly modelInvocable: boolean;
  readonly userInvocable: boolean;
}

/** SkillSummary (index.ts:56-71); name must be kebab-case /^[a-z0-9]+(?:-[a-z0-9]+)*$/ */
export interface HostSkillSummary {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly invocation: HostSkillInvocationPolicy;
  readonly source: 'bundled' | 'runtime';
  readonly provider: string;
}

/** SkillCandidate (index.ts:74-83) */
export interface HostSkillCandidate extends HostSkillSummary {
  readonly rank: number;
  readonly locator: unknown;
}

/** SkillDefinition (index.ts:86-93): content is the Markdown instruction body */
export interface HostSkillDefinition extends HostSkillSummary {
  readonly content: string;
}

/** SkillProvider (index.ts:248-268) */
export interface HostSkillProvider {
  readonly name: string;
  readonly list: (options: unknown) => Promise<readonly HostSkillCandidate[]>;
  readonly get: (candidate: HostSkillCandidate, options: unknown) => Promise<HostSkillDefinition | undefined>;
}

/** SkillProviderControl (index.ts:271-276) + the registerProvider signature (index.ts:391) */
export interface HostSkillRuntime {
  registerProvider(create: (control: { signal: AbortSignal; invalidate: () => void }) => HostSkillProvider): () => void;
}

// ---------------------------------------------------------------------------
// systemPrompt section API (packages/core/system-prompt/src/index.ts:53-85,381-390)
// ---------------------------------------------------------------------------

/** PromptSection (index.ts:53-75): text may be a function (re-evaluated on every assembly; dynamic content allowed); registering a duplicate name throws */
export interface HostPromptSection {
  readonly name: string;
  readonly order: number;
  readonly text: string | ((context: unknown) => string);
  readonly complete?: boolean;
}

/** Minimal SystemPrompt service surface (index.ts:381-390) */
export interface HostSystemPrompt {
  section(section: HostPromptSection): () => void;
}

// ---------------------------------------------------------------------------
// Narrow Context surface: the Cordis Context received by apply(ctx), consumed through a structural assertion
// ---------------------------------------------------------------------------

/** Effect disposer: must tear everything down cleanly and return fast (process-shutdown.ts:45-63, the §3.2 red line) */
export type HostEffectDisposer = () => void | Promise<void>;

/** Minimal Logger surface (the cordis LoggerService carries level methods directly; dsh first-party code uses ctx.logger.warn) */
export interface HostLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * The narrow Context surface this plugin consumes. Hard inject dependencies
 * (tools/agents/sessions/credentials) appear as properties; optional services
 * (commands/skills/systemPrompt) are only probed via ctx.get() (§1.2: inject is a hard
 * wait — with any impl missing the plugin never activates; all three ship in the base
 * bundle by default, but the degradation path must exist).
 * The on() event signatures are verbatim copies: agent events runtime-types.ts:159-178,
 * credentials events types.ts:29. Listeners on the plain ctx receive the scoped events of
 * every agent (scope/src/index.ts:170-181).
 */
export interface HostContext {
  effect(execute: () => HostEffectDisposer, label?: string): unknown;
  get(name: 'commands'): HostCommandRuntime | undefined;
  get(name: 'skills'): HostSkillRuntime | undefined;
  get(name: 'systemPrompt'): HostSystemPrompt | undefined;
  on(name: 'agent/created', listener: (payload: { agent: HostAgent }) => void): () => boolean;
  on(name: 'agent/disposed', listener: (payload: { agent: HostAgent }) => void): () => boolean;
  on(name: 'credentials/updated', listener: (ref: string) => void): () => boolean;
  readonly tools: HostToolRuntime;
  readonly agents: HostAgentRegistry;
  readonly sessions: HostSessionStore;
  readonly credentials: HostCredentialProvider;
  readonly logger: HostLogger;
}
