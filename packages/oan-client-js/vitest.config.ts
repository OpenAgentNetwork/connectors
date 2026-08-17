import { defineConfig } from 'vitest/config';

// About src/__tests__/contract/*.contract.test.ts (the only suite that really hits the
// network): include picks them up, and no exclude is added here on purpose — the gate lives
// inside the file (without OAN_CONTRACT_BASE_URL the whole suite is describe.skipIf-skipped,
// and the file makes no top-level network calls), so a default `vitest run` both stays off the
// network and explicitly records them as skipped, making it obvious at a glance that the gate
// is working. An unconditional exclude here would leave `pnpm test:contract` with nothing to run.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 10000,
  },
});
