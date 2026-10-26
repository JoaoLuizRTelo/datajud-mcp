import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Tests must never reach the network or a real LLM.
    env: { DATAJUD_API_KEY: "test-key", ANTHROPIC_API_KEY: "" },
  },
});
