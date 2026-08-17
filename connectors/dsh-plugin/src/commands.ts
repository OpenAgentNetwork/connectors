// Fallback slash command /oan (the manual pairing channel): the commands service is an
// optional dependency (probed via ctx.get, skipped when missing); the primary path is the
// agent-driven oan_pair tool. recordInput=false — the pairing code is sensitive input and
// must not be recorded in command/run events.
import { runOanPairing, type OanPairExecutorDeps } from './tools.js';
import type { HostCommandDefinition, HostCommandRuntime } from './host-types.js';

/** Register the /oan command; the disposer is reclaimed by the host along with the plugin fiber */
export function registerOanCommand(commands: HostCommandRuntime, pairDeps: OanPairExecutorDeps): void {
  commands.register(oanCommandDefinition(pairDeps));
}

export function oanCommandDefinition(pairDeps: OanPairExecutorDeps): HostCommandDefinition {
  return {
    name: 'oan',
    description: 'OpenAgentNetwork connector: pair this instance (`/oan pair --code <pairing-code>`).',
    input: { hint: 'pair --code <pairing-code> [--base-url <url>] | pair --api-key-file <path>' },
    recordInput: false,
    handler: async (invocation) => {
      const parsed = parseOanCommandInput(invocation.rawInput);
      if (parsed.kind === 'error') return { kind: 'error', text: parsed.message };
      try {
        const text = await runOanPairing(pairDeps, parsed.args);
        return { kind: 'success', text };
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

/** Parse the /oan input line: `pair --code X [--base-url Y]` / `pair --api-key-file P` */
export function parseOanCommandInput(
  rawInput: string,
): { kind: 'pair'; args: { code?: string; apiKeyFile?: string; baseUrl?: string } } | { kind: 'error'; message: string } {
  const tokens = rawInput.trim().split(/\s+/).filter(Boolean);
  const subcommand = tokens.shift();
  if (subcommand !== 'pair') {
    return {
      kind: 'error',
      message: 'Usage: /oan pair --code <pairing-code> [--base-url <url>] | /oan pair --api-key-file <path>',
    };
  }
  const args: { code?: string; apiKeyFile?: string; baseUrl?: string } = {};
  while (tokens.length > 0) {
    const flag = tokens.shift() as string;
    const value = tokens.shift();
    if (!value) return { kind: 'error', message: `Missing value for ${flag}.` };
    if (flag === '--code') args.code = value;
    else if (flag === '--api-key-file') args.apiKeyFile = value;
    else if (flag === '--base-url') args.baseUrl = value;
    else return { kind: 'error', message: `Unknown flag ${flag}.` };
  }
  if (!args.code && !args.apiKeyFile) {
    return { kind: 'error', message: 'Provide --code <pairing-code> or --api-key-file <path>.' };
  }
  return { kind: 'pair', args };
}
