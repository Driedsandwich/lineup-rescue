import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "server-only": new URL("./tests/server-only.ts", import.meta.url).pathname } },
  test: { environment: "node", setupFiles: ["./tests/setup.ts"], clearMocks: true },
});
