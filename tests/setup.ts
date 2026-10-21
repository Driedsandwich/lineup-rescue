import { afterEach, beforeEach, vi } from "vitest";

process.env.QLOO_MODE = "mock";
process.env.LLM_MODE = "mock";
process.env.QLOO_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.LLM_RUNS_PER_IP = "";
process.env.LLM_RUNS_PER_DAY = "";
process.env.QLOO_RUNS_PER_IP = "";
process.env.QLOO_RUNS_PER_IP_DAY = "";
beforeEach(() => {
  // Any unexpected provider request fails immediately, even with keys in the host environment.
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network disabled in tests"); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });
