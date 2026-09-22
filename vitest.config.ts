import { defineConfig } from "vitest/config";

/**
 * Unit tests: pure logic only (validation, config resolution, UI state
 * derivation, ABI drift check). No chain, no network, no database.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/unit/**/*.test.ts"],
    testTimeout: 20_000,
    reporters: "default",
  },
});
