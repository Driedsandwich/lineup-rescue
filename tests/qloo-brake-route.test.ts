import { afterEach, beforeEach, expect, it, vi, type Mocked } from "vitest";
import sample from "../samples/scenario.json";
import { responseSchema } from "../src/lib/contracts";
import type { Qloo } from "../src/lib/qloo/types";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: send }; } }));
const submission = { stop_reason: "tool_use", content: [{ type: "tool_use", id: "submit", name: "submit_rescue_plan", input: {
  plans: [], announcement: { short_post: "Synthetic draft", email_subject: "Synthetic update", email_body: "Synthetic body" }, refund_checklist: [],
} }] };
let client: Mocked<Qloo>;
beforeEach(async () => {
  vi.resetModules();
  send.mockReset().mockResolvedValue(submission);
  const plans = await import("../src/lib/agent/plans");
  vi.spyOn(plans, "llmMode").mockReturnValue("live");
  const { MockQloo } = await import("../src/lib/qloo/mock");
  const fixture = new MockQloo();
  // Live provenance exercises the brake, but every observation is synthetic.
  client = { source: "live", search: vi.fn(fixture.search.bind(fixture)), rank: vi.fn(fixture.rank.bind(fixture)), heat: vi.fn(fixture.heat.bind(fixture)) };
  const qloo = await import("../src/lib/qloo");
  vi.spyOn(qloo, "createQloo").mockImplementation(() => client);
});
afterEach(() => vi.restoreAllMocks());

async function post(name: string, ip = "192.0.2.1", mode: "qloo" | "baseline" = "qloo") {
  const { POST } = await import("../src/app/api/rescue/route");
  const response = await POST(new Request("http://localhost/api/rescue", { method: "POST", headers: {
    "Content-Type": "application/json", "x-forwarded-for": ip,
  }, body: JSON.stringify({ mode, scenario: { ...sample, festival_name: name } }) }));
  expect(response.status).toBe(200);
  expect(response.headers.get("Retry-After")).toBeNull();
  return { response, body: responseSchema.parse(await response.json()) };
}
async function limited(name = "limited", ip?: string) {
  const counts = [client.search.mock.calls.length, client.rank.mock.calls.length, client.heat.mock.calls.length, send.mock.calls.length];
  const result = await post(name, ip);
  expect(result.body.mode).toBe("qloo");
  expect(result.body.llm).toBe("fallback");
  expect(result.body.trace).toContainEqual({ tool: "fallback", params: { reason: "qloo_limit", sub_reason: "client" }, status: "ok", result_count: 0, ms: 0 });
  expect(result.body.trace.some(row => ["resolve_acts", "rank_against_audience", "local_heat", "model_turn"].includes(row.tool))).toBe(false);
  expect(result.body.plans).toHaveLength(3);
  for (const plan of result.body.plans) {
    expect(plan.evidence.fit_original_audience).toBe("Fixed-rule suggestion; no audience data.");
    expect(plan.evidence.fit_lineup_audience).toBe("Fixed-rule suggestion; no audience data.");
  }
  expect(result.body.disclaimers.join(" ")).toContain("Audience data was not fetched because of high request volume from this address. These plans use fixed rules only.");
  expect([client.search.mock.calls.length, client.rank.mock.calls.length, client.heat.mock.calls.length, send.mock.calls.length]).toEqual(counts);
  expect(result.response.headers.get("X-Result-Cache")).toBe("miss");
  return result;
}

it("trips the ten-minute Qloo brake before resolution and never caches the fixed-rule response", async () => {
  vi.stubEnv("QLOO_RUNS_PER_IP", "1");
  vi.stubEnv("QLOO_RUNS_PER_IP_DAY", "10");
  await post("allowed");
  expect(client.search).toHaveBeenCalled();
  const first = await limited();
  expect((await limited()).body.run_id).not.toBe(first.body.run_id);
  expect((await post("other", "192.0.2.2")).body.llm).toBe("live");
  expect(send).toHaveBeenCalledTimes(2);
});

it("trips the per-key daily Qloo brake across ten-minute windows and resets on a UTC day", async () => {
  vi.useFakeTimers();
  const start = Date.parse("2026-10-21T12:00:00Z");
  vi.setSystemTime(start);
  vi.stubEnv("QLOO_RUNS_PER_IP", "1");
  vi.stubEnv("QLOO_RUNS_PER_IP_DAY", "2");
  await post("first");
  vi.setSystemTime(start + 600_000);
  await post("second");
  vi.setSystemTime(start + 1_200_000);
  await limited();
  expect((await post("other", "192.0.2.2")).body.llm).toBe("live");
  vi.setSystemTime(Date.parse("2026-10-22T00:00:00Z"));
  expect((await post("limited")).body.llm).toBe("live");
});

it("cache hits and shared in-flight requests do not consume Qloo runs", async () => {
  vi.stubEnv("QLOO_RUNS_PER_IP", "2");
  vi.stubEnv("QLOO_RUNS_PER_IP_DAY", "2");
  let reply!: (value: typeof submission) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  send.mockImplementationOnce(() => { started(); return new Promise(resolve => { reply = resolve; }); });
  const first = post("shared");
  await ready;
  const { LruCache } = await import("../src/lib/cache");
  const cacheLookup = vi.spyOn(LruCache.prototype, "get");
  const shared = post("shared");
  // Let the second request join before completing the first.
  await vi.waitFor(() => expect(cacheLookup).toHaveBeenCalled());
  reply(submission);
  const [a, b] = await Promise.all([first, shared]);
  expect(b.response.headers.get("X-Result-Cache")).toBe("shared");
  expect(b.body.run_id).toBe(a.body.run_id);
  for (let i = 0; i < 5; i++) expect((await post("shared")).response.headers.get("X-Result-Cache")).toBe("hit");
  expect((await post("second")).body.llm).toBe("live");
  await limited();
  expect((await post("shared")).response.headers.get("X-Result-Cache")).toBe("hit");
  expect(send).toHaveBeenCalledTimes(2);
});

it("mock Qloo and baseline runs skip the Qloo reservation", async () => {
  vi.stubEnv("QLOO_RUNS_PER_IP", "1");
  vi.stubEnv("QLOO_RUNS_PER_IP_DAY", "1");
  const { QlooRunLimiter } = await import("../src/lib/limits");
  const reserve = vi.spyOn(QlooRunLimiter.prototype, "reserve");
  client.source = "mock";
  for (let i = 0; i < 3; i++) expect((await post(`mock-${i}`)).body.llm).toBe("live");
  client.source = "live";
  await post("baseline", undefined, "baseline");
  expect(reserve).not.toHaveBeenCalled();
  expect((await post("live")).body.llm).toBe("live");
  await limited();
});

it.each(["qloo", "model"])("uses the same IPv6 /64 client key for the %s limiter", async kind => {
  vi.stubEnv(kind === "qloo" ? "QLOO_RUNS_PER_IP" : "LLM_RUNS_PER_IP", "1");
  const a = "2001:db8:1:2::1";
  const b = "2001:0db8:0001:0002:ffff:ffff:ffff:2";
  expect((await post("first", a)).body.llm).toBe("live");
  if (kind === "qloo") await limited("second", b);
  else expect((await post("second", b)).body.trace).toContainEqual(expect.objectContaining({ tool: "fallback", params: { reason: "ip_limit" } }));
  expect((await post("different prefix", "2001:db8:1:3::1")).body.llm).toBe("live");
});

it("counts Qloo work even when the model limit selects the existing Qloo fixed-rule planner", async () => {
  vi.stubEnv("LLM_RUNS_PER_IP", "1");
  vi.stubEnv("QLOO_RUNS_PER_IP", "2");
  await post("first");
  const second = await post("model limited");
  expect(second.body.trace).toContainEqual(expect.objectContaining({ tool: "fallback", params: { reason: "ip_limit" } }));
  expect(client.rank).toHaveBeenCalled();
  expect(client.heat).toHaveBeenCalled();
  await limited();
});
