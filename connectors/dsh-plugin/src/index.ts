// @openagentnetwork/dsh-plugin — the DeepSeek Harness connector entry point for
// OpenAgentNetwork (OAN). A thin adapter: all OAN logic comes from
// @openagentnetwork/connector-core; this file only wires up the host — in the
// function-plugin shape (named exports name/inject/Config/apply, never a default export:
// the Loader replaces the whole module namespace with default).
//
// Host APIs are consumed type-only (@deepseek-ai/cordis is imported for types only; zero
// host dependencies at runtime); the only runtime dependencies are schemastery (Config
// validation) and the bundled-in core/client-js.
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import { countPendingInboxItems, DEFAULT_BASE_URL, OAN_MEDIA_MAX_BYTES } from '@openagentnetwork/connector-core';
import { OanInboxBadge } from './badge.js';
import { registerOanCommand } from './commands.js';
import { isOanCredentialRef } from './credentials.js';
import type { HostContext } from './host-types.js';
import { OanRuntime } from './runtime.js';
import { registerOanSkill } from './skill.js';
import { oanStatePaths } from './state.js';
import { createDshOanTools, DSH_HOST_HINTS, DSH_TOOL_RESULT_BUDGET, type OanPairExecutorDeps } from './tools.js';
import { OanWakeManager } from './wake.js';

export const name = 'oan';

// inject lists only hard dependencies (§1.2: inject is a hard wait — with any impl missing
// the plugin never activates); commands/skills/systemPrompt are attached optionally via
// ctx.get(), degrading gracefully when missing instead of blocking the plugin
export const inject = ['tools', 'agents', 'sessions', 'credentials'];

export interface Config {
  baseUrl: string;
  mediaMaxMb: number;
  /** Reserved: default locale for Gofer conversations (currently given per call via the oan_create_gofer parameter) */
  locale?: string;
}

export const Config: z<Config> = z.object({
  baseUrl: z.string().default(DEFAULT_BASE_URL),
  mediaMaxMb: z.number().default(10),
  locale: z.string(),
});

export function apply(ctx: Context, config: Config): void {
  // The dsh service surface on the Cordis Context (tools/agents/…) is declaration-merged by
  // the host packages; under this plugin's type-only policy it is narrowed via a structural
  // assertion to our own surface (host-types.ts, written verbatim against the harness types)
  const host = ctx as unknown as HostContext;
  const log = host.logger;
  const paths = oanStatePaths();
  // Schemastery can be bypassed by programmatic construction (the host's own defensive
  // posture): back the defaults with one more layer here
  const baseUrl = config.baseUrl?.trim() || DEFAULT_BASE_URL;
  const mediaMaxBytes = Math.min(
    (config.mediaMaxMb > 0 ? config.mediaMaxMb : 10) * 1024 * 1024,
    OAN_MEDIA_MAX_BYTES,
  );

  // System-prompt badge (binary section): driven by the inbox pending count
  const badge = new OanInboxBadge();
  const refreshBadge = (): void => {
    void countPendingInboxItems(paths.inboxPath)
      .then((count) => badge.setPending(count > 0))
      .catch(() => {});
  };

  const wake = new OanWakeManager({
    agents: host.agents,
    sessions: host.sessions,
    events: host,
    wakeStorePath: paths.wakePath,
    countPendingItems: () => countPendingInboxItems(paths.inboxPath),
    log,
  });

  const runtime = new OanRuntime({
    paths,
    defaultBaseUrl: baseUrl,
    mediaMaxBytes,
    credentials: host.credentials,
    wake,
    onPendingMaybeChanged: refreshBadge,
    log,
  });

  // Tool registration (the disposer returned by register is reclaimed by the host along with the plugin fiber)
  const pairDeps: OanPairExecutorDeps = {
    defaultBaseUrl: baseUrl,
    currentCredentials: () => runtime.readCredentialsSnapshot(),
    applyPairedCredentials: (credentials) => runtime.applyPairedCredentials(credentials),
  };
  const tools = createDshOanTools(
    runtime.buildCoreToolDeps(DSH_HOST_HINTS, DSH_TOOL_RESULT_BUDGET),
    pairDeps,
    () => runtime.statusExtras(),
  );
  for (const tool of tools) host.tools.register(tool);

  // Optional services: degrade and log when missing — never fail activation over them
  const commands = host.get('commands');
  if (commands) registerOanCommand(commands, pairDeps);
  else log.info('oan: commands service unavailable — /oan fallback command skipped (oan_pair tool remains).');

  const skills = host.get('skills');
  if (skills) registerOanSkill(skills);
  else log.info('oan: skills service unavailable — OAN skill not published (tool descriptions still apply).');

  const systemPrompt = host.get('systemPrompt');
  if (systemPrompt) badge.register(systemPrompt);
  else log.info('oan: systemPrompt service unavailable — inbox badge skipped (wake notes still delivered).');

  // Credential hot-reload: when the credential file is rewritten externally (including
  // oan_pair's own set), restart idempotently (no action on identical values)
  host.on('credentials/updated', (ref) => {
    if (!isOanCredentialRef(ref)) return;
    void runtime.handleCredentialsUpdated().catch((error: unknown) => {
      log.warn(`oan: credentials update handling failed: ${String(error)}`);
    });
  });

  // Connection lifecycle: the disposer must tear everything down cleanly and return fast —
  // an unclosed socket/timer means the process hangs forever (a red line).
  // Shared-resource creation is wrapped in withoutInitiator.
  host.effect(() => {
    host.agents.withoutInitiator(() => {
      wake.start();
      void runtime.start().catch((error: unknown) => {
        log.error(`oan: runtime start failed: ${String(error)}`);
      });
    });
    refreshBadge();
    return async () => {
      wake.stop();
      await runtime.stop();
    };
  }, 'oan.connection()');
}
