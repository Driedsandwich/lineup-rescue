import { afterEach, beforeEach, expect, it, vi } from "vitest";
import sample from "../samples/scenario.json";
import { responseSchema, type Scenario } from "../src/lib/contracts";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: send }; } }));

beforeEach(async () => {
  vi.resetModules();
  send.mockReset().mockImplementation(async params => {
    const input = JSON.parse(params.messages[0].content);
    return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "synthetic-submit", name: "submit_rescue_plan", input: {
      plans: [{ id: "A", title: "Synthetic swap", type: "direct_swap", replacement: input.allowed_replacements[0], promoted_act: null,
        rationale: "Compare the measured evidence and confirm production.", caveats: ["Confirm availability."] }],
      announcement: { short_post: "Synthetic draft", email_subject: "Synthetic update", email_body: "Synthetic body" }, refund_checklist: [],
    } }] };
  });
  const plans = await import("../src/lib/agent/plans");
  vi.spyOn(plans, "llmMode").mockReturnValue("live");
});
afterEach(() => vi.restoreAllMocks());

function fakeTransport(enforceQuota = false) {
  const starts: number[] = [];
  let throttled = 0;
  const transport = vi.fn<typeof fetch>().mockImplementation(async raw => {
    const now = performance.now();
    const recent = starts.filter(start => now - start < 1_000);
    starts.push(now);
    if (enforceQuota && recent.length >= 10) {
      throttled++;
      return new Response(null, { status: 429, headers: { "x-second-ratelimit-reset": "1" } });
    }
    const url = new URL(String(raw));
    const query = url.searchParams;
    if (url.pathname === "/search") {
      const name = query.get("query")!;
      return Response.json({ results: [{ entity_id: `synthetic-${name}`, name, affinity: .8 }] });
    }
    if (query.get("filter.type") === "urn:heatmap") return Response.json({ results: { heatmap: [{ location: { geohash: "9v6kpyq" }, affinity: 1 }] } });
    return Response.json({ results: query.get("filter.results.entities")!.split(",").map(entity_id => ({ entity_id, name: "Synthetic act", affinity: .8 })) });
  });
  return { transport, starts, throttled: () => throttled };
}

async function useTransport(transport: typeof fetch) {
  const qloo = await import("../src/lib/qloo");
  const { QlooClient } = await import("../src/lib/qloo/client");
  vi.spyOn(qloo, "qlooMode").mockReturnValue("live");
  // Fresh clients in each run must still share the per-instance gate and count.
  vi.spyOn(qloo, "createQloo").mockImplementation(() => new QlooClient("synthetic", undefined, transport));
  await import("../src/app/api/rescue/route");
}
async function post(scenario: Scenario, mode: "qloo" | "baseline" = "qloo") {
  const { POST } = await import("../src/app/api/rescue/route");
  const response = await POST(new Request("http://localhost/api/rescue", { method: "POST", headers: {
    "Content-Type": "application/json", "x-forwarded-for": "192.0.2.1",
  }, body: JSON.stringify({ mode, scenario }) }));
  expect(response.status).toBe(200);
  return { response, body: responseSchema.parse(await response.json()) };
}

it("finishes an admitted run across the daily budget, then returns uncached qloo_limit without Qloo or model work", async () => {
  vi.useFakeTimers();
  vi.stubEnv("QLOO_CALLS_PER_DAY", "1");
  const { transport } = fakeTransport();
  await useTransport(transport);
  const { qlooRequests } = await import("../src/lib/qloo/requests");
  const run = post(sample);
  await vi.advanceTimersByTimeAsync(5_000);
  const first = await run;
  expect(first.body.llm).toBe("live");
  expect(first.body.plans).toHaveLength(1);
  expect(transport.mock.calls.length).toBeGreaterThan(1);
  expect(qlooRequests.canStartRun()).toBe(false);
  const sent = transport.mock.calls.length;
  for (let i = 0; i < 3; i++) {
    const limited = await post({ ...sample, festival_name: "Synthetic budget limit" });
    expect(limited.response.headers.get("X-Result-Cache")).toBe("miss");
    expect(limited.body.llm).toBe("fallback");
    expect(limited.body.trace).toContainEqual({ tool: "fallback", params: { reason: "qloo_limit", sub_reason: "daily_budget" }, status: "ok", result_count: 0, ms: 0 });
    expect(limited.body.trace.some(row => ["resolve_acts", "model_turn", "local_heat", "rank_against_audience"].includes(row.tool))).toBe(false);
    expect(limited.body.plans[0].evidence.fit_original_audience).toBe("Fixed-rule suggestion; no audience data.");
    expect(limited.body.disclaimers.join(" ")).toContain("Audience data was not fetched because this server reached its daily Qloo request budget. These plans use fixed rules only.");
    expect(limited.body.disclaimers.join(" ")).not.toContain("high request volume from this address");
    expect(limited.body.run_id).not.toBe(first.body.run_id);
  }
  expect((await post(sample)).response.headers.get("X-Result-Cache")).toBe("hit");
  expect(transport).toHaveBeenCalledTimes(sent);
  expect(send).toHaveBeenCalledTimes(1);
});

it("response-cache hits do not consume the daily budget through the route", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-10-21T23:59:00Z"));
  vi.stubEnv("QLOO_CALLS_PER_DAY", "2");
  const { transport } = fakeTransport();
  await useTransport(transport);
  const { qlooRequests } = await import("../src/lib/qloo/requests");
  const run = post(sample);
  await vi.advanceTimersByTimeAsync(5_000);
  await run;
  vi.setSystemTime(Date.parse("2026-10-22T00:00:00Z"));
  const record = vi.spyOn(qlooRequests, "recordSent");
  const second = await post({ ...sample, festival_name: "Synthetic cached observations" });
  expect(second.body.llm).toBe("live");
  expect(second.response.headers.get("X-Result-Cache")).toBe("miss");
  expect(record).not.toHaveBeenCalled();
  expect(qlooRequests.canStartRun()).toBe(true);
});

it("mock and baseline work do not check or consume the daily Qloo budget", async () => {
  vi.stubEnv("QLOO_CALLS_PER_DAY", "1");
  const { qlooRequests } = await import("../src/lib/qloo/requests");
  const check = vi.spyOn(qlooRequests, "canStartRun");
  const record = vi.spyOn(qlooRequests, "recordSent");
  await post(sample);
  const { transport } = fakeTransport();
  await useTransport(transport);
  await post(sample, "baseline");
  expect(check).not.toHaveBeenCalled();
  expect(record).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});

it("returns plans for concurrent 24-act scenarios under a synthetic ten-request rolling-second Qloo quota", async () => {
  vi.useFakeTimers();
  const fake = fakeTransport(true);
  await useTransport(fake.transport);
  const scenario = (prefix: string): Scenario => ({ ...sample, festival_name: `Synthetic ${prefix}`,
    cancelled_act: { ...sample.cancelled_act, name: `${prefix} Cancelled` },
    lineup: Array.from({ length: 13 }, (_, i) => ({ name: `${prefix} Lineup ${i}`, stage: "Synthetic stage", slot: "Afternoon" })),
    candidates: Array.from({ length: 10 }, (_, i) => ({ name: `${prefix} Candidate ${i}`, available: true, can_arrive_48h: true, notes: "" })),
  });
  const runs = Promise.all([post(scenario("First")), post(scenario("Second"))]);
  await vi.advanceTimersByTimeAsync(15_000);
  const results = await runs;
  for (const result of results) {
    expect(result.body.llm).toBe("live");
    expect(result.body.plans).toHaveLength(1);
    expect(result.body.trace.find(row => row.tool === "resolve_acts")).toMatchObject({ status: "ok", result_count: 24 });
    expect(result.body.trace.some(row => row.status === "error")).toBe(false);
    expect(result.body.plans[0].evidence.fit_lineup_audience).toContain("0.800");
    expect(result.body.plans[0].evidence.local_heat).not.toContain("9v6kpyq");
  }
  expect(fake.throttled()).toBe(0);
  expect(fake.transport.mock.calls.filter(([url]) => new URL(String(url)).pathname === "/search")).toHaveLength(48);
  for (const end of fake.starts) expect(fake.starts.filter(start => start > end - 1_000 && start <= end).length).toBeLessThanOrEqual(8);
  expect(send).toHaveBeenCalledTimes(2);
});
