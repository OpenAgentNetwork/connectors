import { defineConfig } from 'vitest/config';

// About src/__tests__/contract/*.contract.test.ts (the only suite that really hits the network):
// include picks them up, and no exclude is added here on purpose — the gate lives inside the
// files themselves (describe.skipIf skips the whole suite unless the contract environment
// variables are set, and no file makes a top-level network call). A default `vitest run`
// therefore reaches no network yet still reports them as skipped, so whether the gate is
// working is visible at a glance. An unconditional exclude here would also make
// `pnpm test:contract` run nothing at all.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 10000,
  },
});
