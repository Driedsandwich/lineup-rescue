import { afterEach, expect, it, vi } from "vitest";
import { GET } from "../src/app/api/status/route";

afterEach(() => vi.unstubAllEnvs());

it.each([
  ["", "", "live", "live", "mock", "mock"],
  ["synthetic-qloo", "synthetic-llm", "mock", "mock", "mock", "mock"],
  ["synthetic-qloo", "", "live", "live", "live", "mock"],
  ["", "synthetic-llm", "live", "live", "mock", "live"],
  ["synthetic-qloo", "synthetic-llm", "live", "live", "live", "live"],
])("reports independent provider modes without exposing credentials (%s / %s)", async (qKey, lKey, qMode, lMode, qloo, llm) => {
  vi.stubEnv("QLOO_API_KEY", qKey); vi.stubEnv("ANTHROPIC_API_KEY", lKey);
  vi.stubEnv("QLOO_MODE", qMode); vi.stubEnv("LLM_MODE", lMode);
  const response = GET();
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({ qloo, llm });
  expect(fetch).not.toHaveBeenCalled();
});
