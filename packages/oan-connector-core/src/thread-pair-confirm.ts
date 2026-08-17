// POST /threads/:threadId/pair/confirm — an endpoint present in the protocol path table but
// without a typed SDK wrapper. Called through the SDK's escape hatch oanRequest: auth headers
// and the OanApiError contract stay consistent with every other endpoint, with no hand-rolled
// fetch outside the SDK.
import { oanRequest, type AuthMode } from '@openagentnetwork/client-js';
import { OAN_REST_PATHS } from '@openagentnetwork/protocol';

export async function confirmPairing(
  baseUrl: string,
  auth: AuthMode,
  threadId: string,
  input: { roleId: string; accepted: boolean },
): Promise<void> {
  await oanRequest<void>(baseUrl, OAN_REST_PATHS.threads.pairConfirm(threadId), {
    method: 'POST',
    body: input,
    auth,
  });
}
