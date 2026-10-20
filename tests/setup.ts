import { afterEach, beforeEach, vi } from "vitest";

process.env.QLOO_MODE = "mock";
process.env.LLM_MODE = "mock";
process.env.QLOO_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
beforeEach(() => {
  // Any unexpected provider request fails immediately, even with keys in the host environment.
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network disabled in tests"); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
