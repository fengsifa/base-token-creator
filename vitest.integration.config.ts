import { defineConfig } from "vitest/config";

/**
 * Integration tests that talk to a local Hardhat node started by
 * `scripts/run-integration-tests.mjs`. They deploy the real Factory from the
 * committed bytecode and exercise the same ABI the browser uses.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/integration/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    reporters: "default",
  },
});
