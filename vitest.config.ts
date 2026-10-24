import { defineConfig } from "vitest/config";

export default defineConfig({
  // Integration tests drive real HTTP against single-threaded Python mocks running in parallel; give them room.
  test: { include: ["test/**/*.test.ts"], environment: "node", testTimeout: 30_000 },
});
