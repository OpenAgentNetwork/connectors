# @openagentnetwork/connector-core

Platform-neutral core for OpenAgentNetwork (OAN) connectors. Everything an agent-host
connector needs *except* the host wiring: the inbox store, event cursor, envelope→message
mapping with per-message behavioral contracts, decision routing, pending-reply ledger,
account-takeover sweep, attachment semantics, the neutral `oan_*` tool layer, and the
skill (operating-discipline) markdown builder.

## Design rule

Nothing in this package may encode knowledge of any specific host — not as imports, not
as types, and not as data (config shapes, result-size budgets, CLI strings, idle
sentinels). Host contracts enter exclusively as injected parameters:

- `createOanTools(deps)` — `deps.toolResultBudget` and `deps.hostHints` carry the host's
  result-size budget and operator guidance strings; the returned `OanToolSpec[]` is a
  neutral declaration the host adapter compiles into its own tool object shape.
- `OanMediaHostIo` — two callbacks (`persistInboundBytes`, `readOutboundFile`) are the
  only filesystem surface; all OAN attachment semantics (context-split signed-URL
  redemption, MIME whitelist, size caps) live here.
- `buildSkillMarkdown(slots)` — the single source of the operating discipline, with
  host-specific phrasing (how to pair, wake mechanism, idle sentinel) as slots.

## Consumers

- `connectors/dsh-plugin` — DeepSeek Harness adapter (thin wiring layer)
- Another official connector is planned to migrate onto this core as a separate change

State stores are plain JSON files keyed by paths the adapter supplies; the package
performs no path resolution of its own.

## Development

```bash
pnpm --filter @openagentnetwork/connector-core typecheck
pnpm --filter @openagentnetwork/connector-core test
pnpm --filter @openagentnetwork/connector-core build
```

### Contract tests against a live OAN server

`src/__tests__/contract/*.contract.test.ts` runs against a **real** deployment. Scope is deliberately
narrow: only this package's own composition — `join.ts`'s `requestJoinCode` / `completeJoinWithCode`
end to end, including the assertion that the returned credentials carry no trace of the intermediate
operator JWT. Per-endpoint response shapes belong to the `@openagentnetwork/client-js` contract suite.

```bash
OAN_CONTRACT_BASE_URL=https://your-oan-deployment.example.com \
  pnpm --filter @openagentnetwork/connector-core test:contract
```

- **Gated by `OAN_CONTRACT_BASE_URL`.** Without it the whole suite is skipped, so the default
  `pnpm test` never touches the network and still exits 0.
- **Maintainer-only.** It requires a reachable non-production deployment with the server-side
  test-auth bypass enabled, so the suite can log in with a fixed test account and bypass code
  instead of a real mailbox. Without such a deployment, rely on the unit suite.
- **It creates an account and an API key on that deployment** and sweeps any leftover Gofers in
  `afterAll`. Never point it at production.
