import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import sample from "../samples/scenario.json";
import { responseSchema } from "../src/lib/contracts";
import ResultPanel from "../src/app/result-panel";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: send }; } }));

const submission = { stop_reason: "tool_use", content: [{ type: "tool_use", id: "submit", name: "submit_rescue_plan", input: {
  plans: [], announcement: { short_post: "Synthetic draft", email_subject: "Synthetic update", email_body: "Synthetic draft body" },
  refund_checklist: sample.ticket_types.map(ticket_type => ({ ticket_type, items: ["Verify published terms."] })),
} }] };
async function post(name: string, ip = "synthetic-ip", mode: "qloo" | "baseline" = "qloo") {
  const { POST } = await import("../src/app/api/rescue/route");
  const response = await POST(new Request("http://localhost/api/rescue", { method: "POST", headers: {
    "Content-Type": "application/json", "x-forwarded-for": ip,
  }, body: JSON.stringify({ mode, scenario: { ...sample, festival_name: name } }) }));
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Retry-After")).toBeNull();
  return { response, body: responseSchema.parse(await response.json()) };
}
beforeEach(async () => {
  vi.resetModules();
  send.mockReset().mockResolvedValue(submission);
  const plans = await import("../src/lib/agent/plans");
  vi.spyOn(plans, "llmMode").mockReturnValue("live");
});
afterEach(() => vi.restoreAllMocks());

it("degrades at the per-IP env limit, preserves evidence, and never caches limit fallbacks", async () => {
  vi.stubEnv("LLM_RUNS_PER_IP", "2");
  vi.stubEnv("LLM_RUNS_PER_DAY", "3");
  expect((await post("first")).body.llm).toBe("live");
  expect((await post("second")).body.llm).toBe("live");
  const first = await post("limited");
  const second = await post("limited");
  expect(first.body.llm).toBe("fallback");
  expect(first.body.plans).toHaveLength(3);
  expect(first.body.trace).toContainEqual(expect.objectContaining({ tool: "fallback", params: { reason: "ip_limit" } }));
  expect(first.body.trace.some(row => row.tool === "model_turn")).toBe(false);
  expect(first.body.trace.some(row => row.tool === "rank_against_audience")).toBe(true);
  expect(first.body.disclaimers.join(" ")).toContain("Per-IP usage limit for the language model reached.");
  expect(first.body.disclaimers.join(" ")).toContain("assembled by fixed rules from the same Qloo evidence.");
  expect(first.body.disclaimers.join(" ")).not.toContain("time budget");
  expect(first.response.headers.get("X-Result-Cache")).toBe("miss");
  expect(second.response.headers.get("X-Result-Cache")).toBe("miss");
  expect(second.body.run_id).not.toBe(first.body.run_id);
  // Limit fallbacks did not spend the remaining daily model slot.
  expect((await post("other IP", "synthetic-other")).body.llm).toBe("live");
  expect(send).toHaveBeenCalledTimes(3);
  const html = renderToStaticMarkup(createElement(ResultPanel, { result: first.body, differences: [], busy: false,
    pendingChoices: false, resolutions: {}, choose: () => {}, rerun: () => {} }));
  expect(html).toContain("Per-IP usage limit for the language model reached.");
  expect(html).toContain('class="notice" role="status"');
});

it("degrades at the global daily env limit without consuming the denied IP's quota", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-21T23:59:00Z"));
  vi.stubEnv("LLM_RUNS_PER_IP", "1");
  vi.stubEnv("LLM_RUNS_PER_DAY", "2");
  await post("first", "a");
  await post("second", "b");
  for (let i = 0; i < 2; i++) {
    const { response, body } = await post("limited", "c", "baseline");
    expect(body.llm).toBe("fallback");
    expect(response.headers.get("X-Result-Cache")).toBe("miss");
    expect(body.trace).toContainEqual(expect.objectContaining({ tool: "fallback", params: { reason: "daily_cap" } }));
    expect(body.trace.some(row => row.tool === "model_turn")).toBe(false);
    expect(body.disclaimers.join(" ")).toContain("Daily usage limit for the language model reached on this server.");
    expect(body.disclaimers.join(" ")).toContain("no Qloo evidence was used");
  }
  expect(send).toHaveBeenCalledTimes(2);
  vi.setSystemTime(new Date("2026-10-22T00:00:00Z"));
  // Same IP window, new UTC day: daily denials never counted as IP runs.
  expect((await post("limited", "c", "baseline")).body.llm).toBe("live");
  expect(send).toHaveBeenCalledTimes(3);
});

it("ignores cache hits for both counters and still serves cached live results after limits", async () => {
  vi.stubEnv("LLM_RUNS_PER_IP", "2");
  vi.stubEnv("LLM_RUNS_PER_DAY", "3");
  const first = await post("cached");
  for (let i = 0; i < 25; i++) {
    const cached = await post("cached");
    expect(cached.response.headers.get("X-Result-Cache")).toBe("hit");
    expect(cached.body.run_id).toBe(first.body.run_id);
  }
  expect((await post("second")).body.llm).toBe("live");
  expect((await post("third", "other")).body.llm).toBe("live");
  expect((await post("fourth", "another")).body.llm).toBe("fallback");
  expect((await post("cached")).body.run_id).toBe(first.body.run_id);
  expect(send).toHaveBeenCalledTimes(3);
});

it.each(["provider", "deadline"])("keeps a sent %s attempt counted on both model counters", async reason => {
  vi.stubEnv("LLM_RUNS_PER_IP", "1");
  vi.stubEnv("LLM_RUNS_PER_DAY", "1");
  if (reason === "provider") send.mockRejectedValueOnce(new Error("synthetic failure"));
  else {
    vi.useFakeTimers();
    send.mockImplementationOnce(() => new Promise(() => {}));
  }
  const run = post("sent fallback");
  if (reason === "deadline") await vi.advanceTimersByTimeAsync(40_000);
  const { body } = await run;
  expect(body.llm).toBe("fallback");
  expect(body.trace).toContainEqual(expect.objectContaining({ tool: "fallback", params: expect.objectContaining({ reason }) }));
  expect((await post("now limited")).body.llm).toBe("fallback");
  expect((await post("other IP", "other")).body.trace).toContainEqual(expect.objectContaining({ tool: "fallback", params: { reason: "daily_cap" } }));
  expect(send).toHaveBeenCalledTimes(1);
});

it("reserves in-flight model work and shares identical requests without counting twice", async () => {
  vi.stubEnv("LLM_RUNS_PER_IP", "1");
  vi.stubEnv("LLM_RUNS_PER_DAY", "2");
  let reply!: (value: typeof submission) => void;
  let started!: () => void;
  const modelStarted = new Promise<void>(resolve => { started = resolve; });
  send.mockImplementationOnce(() => { started(); return new Promise(resolve => { reply = resolve; }); });
  const first = post("concurrent");
  await modelStarted;
  const shared = post("concurrent");
  expect((await post("different")).body.llm).toBe("fallback");
  reply(submission);
  const [a, b] = await Promise.all([first, shared]);
  expect(b.response.headers.get("X-Result-Cache")).toBe("shared");
  expect(b.body.run_id).toBe(a.body.run_id);
  expect((await post("other", "other")).body.llm).toBe("live");
  expect(send).toHaveBeenCalledTimes(2);
});

it("never reserves model quota for deterministic mock runs or failed Qloo pre-resolution", async () => {
  const { RunLimiter } = await import("../src/lib/limits");
  const reserve = vi.spyOn(RunLimiter.prototype, "reserve");
  const plans = await import("../src/lib/agent/plans");
  vi.mocked(plans.llmMode).mockReturnValue("mock");
  expect((await post("mock")).body.llm).toBe("mock");
  vi.mocked(plans.llmMode).mockReturnValue("live");
  const qloo = await import("../src/lib/qloo");
  vi.spyOn(qloo, "createQloo").mockReturnValue({ source: "live", search: async () => { throw new Error("synthetic failure"); },
    rank: async () => [], heat: async () => [] });
  const { runAgent } = await import("../src/lib/agent/loop");
  await expect(runAgent({ mode: "qloo", scenario: sample }, new AbortController().signal, {
    reserveModel: () => new RunLimiter().reserve("synthetic"),
  })).rejects.toMatchObject({ code: "provider" });
  expect(reserve).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});
