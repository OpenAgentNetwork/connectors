// Tool assembly: the 8 core tools (platform-neutral OanToolSpec) + the three DSH-specific
// join tools (oan_join / oan_verify / oan_pair), compiled into host raw ToolDefinitions and
// registered.
//
// Two hard contracts with the host:
// - The host does not validate arguments against parameters ("tools validate their own
//   schema") — execute must self-validate; arguments can be any JSON value (even a
//   bare string/null when the model misbehaves).
// - Successful outputs are strictly validated against output.schema (violations become
//   INVALID_TOOL_OUTPUT) — the schema is always { type: 'string' } and execute always
//   returns a string, so this is safe.
import { readFile } from 'node:fs/promises';
import {
  completeJoinWithCode,
  createOanTools,
  redeemPairingCredentials,
  requestJoinCode,
  verifyApiKeyCredentials,
  type OanCoreToolDeps,
  type OanHostHints,
  type OanPairedCredentials,
  type OanToolSpec,
} from '@openagentnetwork/connector-core';
import type { HostToolDefinition } from './host-types.js';
import type { OanPairApplyOutcome } from './runtime.js';

/**
 * Character budget for a single tool result: DSH has no host-level
 * whole-result truncation, but the base bundle's compaction pruner later trims results
 * >8192 characters down to head 4096 + tail 1024 — a budget of 8000 makes core paginate on
 * its own, keeping results intact for the whole session lifetime.
 */
export const DSH_TOOL_RESULT_BUDGET = 8000;

/**
 * Host guidance slots (every "what to do on the host" phrase in the core copy comes from
 * here). howToPair goes both into the skill's "Not paired yet" section and into the
 * requireCredentials error text, so it must stand alone as a complete, actionable
 * sequence — the standard flow is driven end-to-end by the agent, with the human involved
 * exactly twice.
 */
export const DSH_HOST_HINTS: OanHostHints = {
  howToPair:
    'Drive the join yourself with the tools you already have; your user takes part exactly twice. ' +
    '(1) Ask your user which email address to register with, then call `oan_join` with that email — a ' +
    '6-digit code is sent to it. This is the same path whether or not they already have an OAN account: ' +
    'the one call both signs in an existing account and creates a new one, so do not ask which they have. ' +
    '(2) Ask your user for the 6-digit code from their inbox, then call `oan_verify` with the same email ' +
    'and that code — it obtains this instance\'s own credential, stores it, and connects right away, with ' +
    'no restart. Never ask your user for a pairing code: `oan_verify` obtains one internally. ' +
    '(Only if your user separately generated a pairing code on the OAN website, `oan_pair` accepts it directly.)',
  howToRecover:
    'If a pairing code was already redeemed but pairing did not complete, call oan_pair with apiKeyFile ' +
    'pointing at the file holding the redeem response.',
  howToUpdate:
    'Give your user this one line to paste into their terminal — it re-resolves the plugin to the '
    + 'published version (an install is pinned by the profile lockfile, so re-running the original '
    + 'add command is what updates it):\n\n'
    + '```\nnpx @deepseek-ai/dsh plugin --profile web add @openagentnetwork/dsh-plugin\n```\n\n'
    + 'Then they must stop the running harness and start it again (`npx @deepseek-ai/dsh web`) — a '
    + 'plugin is only loaded at startup, so without the restart they stay on the old version. '
    + 'If their profile is not named `web`, the same command takes their profile name instead.',
  howToRestart:
    'ask your user to stop the running harness and start it again once — the launch line is '
    + '`npx @deepseek-ai/dsh web`, and every harness command you give them takes that same '
    + '`npx @deepseek-ai/dsh …` form; never shorten it',
  idleSentinel:
    'Only end the turn after every item has its disposition: anything that went to your user is this ' +
    "turn's reply; if every item was answered to its Gofer, close the turn with a one-line note rather " +
    'than an empty turn.',
};

/** Execution dependencies of the three join tools (wired by the runtime; protocol calls and file reads injectable for tests) */
export interface OanPairExecutorDeps {
  defaultBaseUrl: string;
  currentCredentials: () => OanPairedCredentials | undefined;
  applyPairedCredentials: (credentials: OanPairedCredentials) => Promise<OanPairApplyOutcome>;
  requestJoin?: typeof requestJoinCode;
  completeJoin?: typeof completeJoinWithCode;
  redeem?: typeof redeemPairingCredentials;
  verifyKey?: typeof verifyApiKeyCredentials;
  readFileText?: (path: string) => Promise<string>;
}

/** The source platform this DSH connector declares to OAN (server-side allowlist: openclaw|hermes|dsh|other) */
const DSH_CONNECTOR_PLATFORM = 'dsh';

/** The full DSH tool set: the 8 core tools (oan_status gains DSH-specific extra lines) + the three join tools */
export function createDshOanTools(
  coreDeps: OanCoreToolDeps,
  pairDeps: OanPairExecutorDeps,
  statusExtras: () => string[],
): HostToolDefinition[] {
  const specs = createOanTools(coreDeps).map((spec) =>
    spec.name === 'oan_status' ? augmentStatusSpec(spec, statusExtras) : spec,
  );
  specs.push(oanJoinSpec(pairDeps), oanVerifySpec(pairDeps), oanPairSpec(pairDeps));
  return specs.map(toolSpecToDshTool);
}

/**
 * Platform-neutral OanToolSpec → host raw ToolDefinition.
 * parameters compiles into a JSON Schema object; execute self-validates its arguments
 * (§2.3); output.schema is always string + render emits a text block (§2.1: output is the
 * hard gate at registration).
 */
export function toolSpecToDshTool(spec: OanToolSpec): HostToolDefinition {
  const required = Object.entries(spec.parameters)
    .filter(([, parameter]) => parameter.required === true)
    .map(([key]) => key);
  return {
    name: spec.name,
    description: spec.description,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(spec.parameters).map(([key, parameter]) => [
          key,
          { type: 'string', description: parameter.description },
        ]),
      ),
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async (args) => spec.run(validateToolArgs(spec, args)),
  };
}

/**
 * Argument self-validation (the host validates nothing, §2.3): non-object arguments are
 * treated as an empty object (the model may emit bare values — an empty object makes the
 * missing-parameter error name the field, which the model can learn from); a missing
 * required field or a type mismatch throws an error naming the field.
 */
export function validateToolArgs(spec: OanToolSpec, args: unknown): Record<string, string | undefined> {
  const record =
    typeof args === 'object' && args !== null && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  const out: Record<string, string | undefined> = {};
  for (const [key, parameter] of Object.entries(spec.parameters)) {
    const value = record[key];
    if (value === undefined || value === null) {
      if (parameter.required === true) {
        throw new Error(`Missing required parameter "${key}" for ${spec.name}.`);
      }
      continue;
    }
    if (typeof value !== 'string') {
      throw new Error(`Parameter "${key}" of ${spec.name} must be a string.`);
    }
    out[key] = value;
  }
  return out;
}

/** DSH extras for oan_status: host-side diagnostic lines appended after the core output (two-instance lock / headless / allow mask) */
function augmentStatusSpec(spec: OanToolSpec, statusExtras: () => string[]): OanToolSpec {
  return {
    ...spec,
    run: async (args) => {
      const base = await spec.run(args);
      const extras = statusExtras();
      return extras.length > 0 ? `${base}\n${extras.join('\n')}` : base;
    },
  };
}

/**
 * Join step 1, oan_join: send a 6-digit verification code to the user's email.
 * The description must close off two failure modes seen on live instances — asking the user
 * "do you have an account" first, and asking the user for a pairing code.
 */
function oanJoinSpec(deps: OanPairExecutorDeps): OanToolSpec {
  return {
    name: 'oan_join',
    description:
      'Step 1 of joining OpenAgentNetwork: send a 6-digit verification code to your user\'s email address. ' +
      'This is the way in whether or not your user already has an OAN account — the same call signs in an ' +
      'existing account and creates a new one. Do not ask your user whether they have an account, and never ' +
      'ask them for a pairing code: the pairing code is obtained internally by oan_verify. The only thing to ' +
      'ask for is the email address to register with. After this tool succeeds, ask your user for the 6-digit ' +
      'code from that inbox and call oan_verify with the same email and that code.',
    parameters: {
      email: {
        type: 'string',
        required: true,
        description: "Your user's email address to register or sign in with.",
      },
      baseUrl: {
        type: 'string',
        description: 'OAN API base URL override. Defaults to the stored or configured base URL.',
      },
    },
    run: (args) => runOanJoin(deps, { email: args.email, baseUrl: args.baseUrl }),
  };
}

/**
 * Join step 2, oan_verify: verification code → connector credential (core
 * completeJoinWithCode redeems internally and discards the JWT) → store in the host
 * credentials store → connect on the spot. The key and the JWT never appear in the returned
 * text.
 */
function oanVerifySpec(deps: OanPairExecutorDeps): OanToolSpec {
  return {
    name: 'oan_verify',
    description:
      'Step 2 of joining OpenAgentNetwork: exchange the 6-digit code your user read from their email for this ' +
      "instance's own credential, store it, and connect immediately — no restart needed. Pass the same email " +
      'you gave oan_join. Call it once per code: a code is consumed the moment verification succeeds, so a ' +
      'repeat call reports the code as already used rather than meaning it was wrong. Reports CONNECTED on ' +
      'success, or the exact failure reason; the credential itself never appears in the result.',
    parameters: {
      email: {
        type: 'string',
        required: true,
        description: 'The same email address that was passed to oan_join.',
      },
      code: {
        type: 'string',
        required: true,
        description: 'The 6-digit verification code your user received by email.',
      },
      baseUrl: {
        type: 'string',
        description: 'OAN API base URL override. Defaults to the stored or configured base URL.',
      },
    },
    run: (args) => runOanVerify(deps, { email: args.email, code: args.code, baseUrl: args.baseUrl }),
  };
}

/**
 * Fallback path oan_pair (for when the user generated a pairing code themselves on the
 * website): in-process redeem/verification → writability pre-check → credentials into the
 * host credentials store → connect on the spot → report the first-connection result
 * honestly. The recovery parameter apiKeyFile takes a file path rather than the raw key —
 * the key stays out of the model context (the capture-to-file discipline).
 */
function oanPairSpec(deps: OanPairExecutorDeps): OanToolSpec {
  return {
    name: 'oan_pair',
    description:
      'Pair this dsh instance with an OpenAgentNetwork account and connect immediately. This is the fallback ' +
      'path, for a pairing code your user generated themselves on the OAN website — the normal way to join is ' +
      'oan_join followed by oan_verify, which needs only an email address and the 6-digit code. Provide either `code` ' +
      '(a one-time pairing code from your user\'s OAN account page) or `apiKeyFile` (recovery path: absolute ' +
      'path to a file holding an already-redeemed API key — as plain text or JSON with an "apiKey" field; ' +
      'never paste the key itself into arguments). Reports CONNECTED on success, or the exact failure reason.',
    parameters: {
      code: {
        type: 'string',
        description: 'One-time pairing code from the OAN account page. Mutually exclusive with apiKeyFile.',
      },
      apiKeyFile: {
        type: 'string',
        description:
          'Absolute path to a file containing an already-redeemed API key (plain text or JSON {"apiKey": ...}). ' +
          'Use when a pairing code was redeemed but pairing did not complete.',
      },
      baseUrl: {
        type: 'string',
        description: 'OAN API base URL override. Defaults to the stored or configured base URL.',
      },
    },
    run: (args) =>
      runOanPairing(deps, {
        code: args.code,
        apiKeyFile: args.apiKeyFile,
        baseUrl: args.baseUrl,
      }),
  };
}

/** The oan_join execution path: core protocol call + unreachability diagnosis; on success, direct the agent to go ask for the verification code. */
export async function runOanJoin(
  deps: OanPairExecutorDeps,
  args: { email?: string; baseUrl?: string },
): Promise<string> {
  const email = args.email?.trim();
  if (!email) {
    throw new Error('Provide `email` — ask your user which email address to register with.');
  }
  const baseUrl = resolveBaseUrl(deps, args.baseUrl);
  await withReachableBaseUrl(baseUrl, () => (deps.requestJoin ?? requestJoinCode)(baseUrl, email));
  return (
    `A 6-digit verification code was sent to ${email} by ${baseUrl}. Nothing is paired yet. Ask your user for ` +
    `that code now, then call oan_verify with email "${email}" and the code they read you. The code is ` +
    'short-lived; if it never arrives or has expired, call oan_join again to send a fresh one.'
  );
}

/** The oan_verify execution path: verification code → credentials → store and connect. The returned text never contains the key or the JWT. */
export async function runOanVerify(
  deps: OanPairExecutorDeps,
  args: { email?: string; code?: string; baseUrl?: string },
): Promise<string> {
  const email = args.email?.trim();
  const code = args.code?.trim();
  if (!email) {
    throw new Error('Provide `email` — the same address that was passed to oan_join.');
  }
  if (!code) {
    throw new Error('Provide `code` — the 6-digit verification code your user received by email.');
  }
  const baseUrl = resolveBaseUrl(deps, args.baseUrl);
  const credentials = await withReachableBaseUrl(baseUrl, () =>
    (deps.completeJoin ?? completeJoinWithCode)(baseUrl, email, code, DSH_CONNECTOR_PLATFORM),
  );
  return describeApplyOutcome(credentials, await deps.applyPairedCredentials(credentials));
}

/** The execution path shared by oan_pair and the /oan pair fallback command. The returned text never contains the key itself. */
export async function runOanPairing(
  deps: OanPairExecutorDeps,
  args: { code?: string; apiKeyFile?: string; baseUrl?: string },
): Promise<string> {
  const code = args.code?.trim();
  const apiKeyFile = args.apiKeyFile?.trim();
  if (!code && !apiKeyFile) {
    throw new Error(
      'Provide either `code` (a pairing code from the OAN account page) or `apiKeyFile` (path to a file ' +
        'holding the redeemed API key).',
    );
  }
  if (code && apiKeyFile) {
    throw new Error('Provide only one of `code` or `apiKeyFile`, not both.');
  }
  const baseUrl = resolveBaseUrl(deps, args.baseUrl);

  let credentials: OanPairedCredentials;
  if (code) {
    credentials = await withReachableBaseUrl(baseUrl, () =>
      (deps.redeem ?? redeemPairingCredentials)(baseUrl, code),
    );
  } else {
    const raw = await (deps.readFileText ?? ((p: string) => readFile(p, 'utf8')))(apiKeyFile as string);
    const apiKey = extractApiKey(raw);
    if (!apiKey) {
      throw new Error(
        `No API key found in ${apiKeyFile}. Expected plain text containing the key, or JSON with an "apiKey" field.`,
      );
    }
    credentials = await withReachableBaseUrl(baseUrl, () =>
      (deps.verifyKey ?? verifyApiKeyCredentials)(baseUrl, apiKey),
    );
  }

  return describeApplyOutcome(credentials, await deps.applyPairedCredentials(credentials));
}

/** Credential landing outcome → an honest report for the agent (shared by oan_verify and oan_pair; never contains the key itself) */
function describeApplyOutcome(credentials: OanPairedCredentials, outcome: OanPairApplyOutcome): string {
  switch (outcome.kind) {
    case 'already-connected':
      return (
        `Already paired to ${credentials.baseUrl} with these exact credentials and CONNECTED — nothing changed, ` +
        'no reconnect was needed.'
      );
    case 'connected':
      return (
        `CONNECTED to ${credentials.baseUrl}. Credentials are stored in the dsh credential store; the connection ` +
        'now stays up and reconnects automatically. Gofer messages will arrive in the OAN inbox — a note will ' +
        'wake you when items are pending.'
      );
    case 'failed':
      return (
        `Credentials were verified and stored, but the first connection attempt did not succeed: ${outcome.reason}. ` +
        'The connector keeps retrying automatically — check oan_status in a moment. If the reason indicates ' +
        '401/unauthorized, join again from oan_join.'
      );
  }
}

/** Base URL resolution (consistent across the three join tools): argument > existing credentials > config default */
function resolveBaseUrl(deps: OanPairExecutorDeps, argBaseUrl?: string): string {
  return argBaseUrl?.trim() || deps.currentCredentials()?.baseUrl || deps.defaultBaseUrl;
}

/**
 * Dedicated diagnosis for an unreachable server address: a DNS/connection-layer failure and
 * "wrong credentials" are two different things — conflating them sends the agent back to
 * the user for fresh codes over and over (seen on a live instance: the default domain was
 * not live yet and the agent got stuck on "fetch failed").
 */
async function withReachableBaseUrl<T>(baseUrl: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isUnreachableError(error)) throw error;
    throw new Error(
      `The OpenAgentNetwork server at ${baseUrl} is unreachable (${describeError(error)}) — the request never ` +
        'got there, so this is not a credential problem and nothing was consumed. If this deployment lives at ' +
        'a different address, pass `baseUrl` to this tool (or set the plugin\'s baseUrl config) and retry; ' +
        'otherwise the network or the server is down.',
    );
  }
}

/**
 * Transport-layer failure detection: errors carrying a numeric status came from a server
 * response (OanApiError) and never count as unreachable; the rest are matched against
 * Node/undici connection error codes and fetch's generic "fetch failed", walking the cause
 * chain.
 */
function isUnreachableError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const record = current as { status?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    if (typeof record.status === 'number') return false;
    if (typeof record.code === 'string' && UNREACHABLE_CODES.has(record.code)) return true;
    if (typeof record.message === 'string' && /fetch failed|getaddrinfo|ECONNREFUSED/i.test(record.message)) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

/** Error codes Node/undici emit on DNS or TCP layer failures */
const UNREACHABLE_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

function describeError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return typeof code === 'string' && !message.includes(code) ? `${code}: ${message}` : message;
}

/** Extract the key from apiKeyFile content: JSON apiKey field > gofers_-prefixed token match > single-token plain text */
export function extractApiKey(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && typeof (parsed as { apiKey?: unknown }).apiKey === 'string') {
      const key = (parsed as { apiKey: string }).apiKey.trim();
      return key || undefined;
    }
  } catch {
    // not JSON: fall through to plain-text parsing
  }
  const match = trimmed.match(/gofers_[A-Za-z0-9_-]+/);
  if (match) return match[0];
  return /\s/.test(trimmed) ? undefined : trimmed;
}
