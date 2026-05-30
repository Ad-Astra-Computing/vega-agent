import { defineConfig } from "vitest/config";

// The agent core is pure Node logic, so the tests run in the default Node
// environment (no workerd). The nix shelling in agent/nix.ts is exercised on a
// real runner, not here.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
