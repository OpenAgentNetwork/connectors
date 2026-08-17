// Core logic of the first-time pairing flow: collect a baseUrl + pairing code, redeem them
// for a connector API key, and hand it to the host to persist. Depends on no host package, so
// it unit-tests without a real host; the adapter only casts its own interactive-input and
// config-write capabilities into SetupHostBindings before calling in.
import { redeemPairingCredentials, type OanPairedCredentials } from './pairing.js';

export const DEFAULT_BASE_URL = 'https://api.openagentnetwork.ai';

export interface SetupHostBindings {
  /** Prompt the user for one line of text; empty/undefined is treated as no input */
  promptText(question: string, opts?: { default?: string }): Promise<string | undefined>;
  /** Persist the redeemed credentials into the host's own config/credential store */
  writeCredentials(credentials: OanPairedCredentials): Promise<void> | void;
  logInfo(message: string): void;
  logWarn(message: string): void;
}

export async function runPairingSetup(host: SetupHostBindings): Promise<void> {
  const baseUrlInput = await host.promptText('OAN API base URL', { default: DEFAULT_BASE_URL });
  const baseUrl = baseUrlInput?.trim() || DEFAULT_BASE_URL;

  const pairingCode = await host.promptText('Pairing code (from your OAN account)');
  if (!pairingCode?.trim()) {
    host.logWarn('No pairing code entered — OpenAgentNetwork connector left unconfigured.');
    return;
  }

  const credentials = await redeemPairingCredentials(baseUrl, pairingCode);
  await host.writeCredentials(credentials);
  host.logInfo('OpenAgentNetwork connector paired successfully.');
}
