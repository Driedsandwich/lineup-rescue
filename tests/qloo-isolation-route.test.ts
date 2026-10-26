import { afterEach, beforeEach, expect, it, vi } from "vitest";
import sample from "../samples/scenario.json";
import { responseSchema, type Scenario } from "../src/lib/contracts";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: send }; } }));

const scenario: Scenario = { ...sample, candidates: Array.from({ length: 8 }, (_, i) => ({
  name: `Synthetic Candidate ${i + 1}`, available: true, can_arrive_48h: true, notes: "",
})) };

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  // Native AbortSignal.timeout uses a separate clock. Drive the same 15-second
  // deadlines with fake timers so no test waits for real time or uses a network.
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Synthetic timeout", "TimeoutError")), ms);
    return controller.signal;
  });
  send.mockReset().mockImplementation(async params => {
    const input = JSON.parse(params.messages[0].content);
    const replacement = input.allowed_replacements[0];
    const promoted = input.allowed_promotions[0];
    return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "synthetic-submit", name: "submit_rescue_plan", input: {
      plans: [
        { id: "A", title: "Synthetic swap", type: "direct_swap", replacement, promoted_act: null,
          rationale: "Confirm production and fees.", caveats: ["Confirm availability."] },
        ...(promoted ? [{ id: "B", title: "Synthetic promotion", type: "promote_and_fill", replacement, promoted_act: promoted,
          rationale: "Confirm both affected slots.", caveats: ["Confirm timing."] }] : []),
      ],
      announcement: { short_post: "Synthetic draft", email_subject: "Synthetic update", email_body: "Synthetic body" }, refund_checklist: [],
    } }] };
  });
  const plans = await import("../src/lib/agent/plans");
  vi.spyOn(plans, "llmMode").mockReturnValue("live");
});
afterEach(() => vi.restoreAllMocks());

async function harness(failed: Set<string>, failure: "timeout" | "network" | "http" = "network") {
  const transport = vi.fn<typeof fetch>().mockImplementation(async (raw, init) => {
    const url = new URL(String(raw));
    if (url.pathname === "/search") {
      const name = url.searchParams.get("query")!;
      if (failed.has(name)) {
        if (failure === "http") return new Response(null, { status: 503 });
        if (failure === "network") throw new TypeError("Synthetic network failure");
        const signal = init!.signal!;
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          if (signal.aborted) reject(signal.reason);
        });
      }
      return Response.json({ results: [{ entity_id: `synthetic-${name}`, name }] });
    }
    if (url.searchParams.get("filter.type") === "urn:heatmap") return Response.json({ results: { heatmap: [{ name: "Synthetic area", affinity: .8 }] } });
    return Response.json({ results: url.searchParams.get("filter.results.entities")!.split(",").map(entity_id => ({ entity_id, name: "Synthetic act", affinity: .8 })) });
  });
  const qloo = await import("../src/lib/qloo");
  const { QlooClient } = await import("../src/lib/qloo/client");
  vi.spyOn(qloo, "qlooMode").mockReturnValue("live");
  vi.spyOn(qloo, "createQloo").mockImplementation(() => new QlooClient("synthetic", undefined, transport));
  const { POST } = await import("../src/app/api/rescue/route");
  const post = () => POST(new Request("http://localhost/api/rescue", { method: "POST", headers: {
    "Content-Type": "application/json", "x-forwarded-for": "192.0.2.1",
  }, body: JSON.stringify({ mode: "qloo", scenario }) }));
  const searches = (name: string) => transport.mock.calls.filter(([raw]) => {
    const url = new URL(String(raw));
    return url.pathname === "/search" && url.searchParams.get("query") === name;
  });
  const expectUnscored = (names: string[]) => {
    for (const [raw] of transport.mock.calls) {
      const url = new URL(String(raw));
      if (url.pathname === "/search") continue;
      const ids = ["filter.results.entities", "signal.interests.entities"].flatMap(key => url.searchParams.get(key)?.split(",") ?? []);
      for (const name of names) expect(ids).not.toContain(`synthetic-${name}`);
    }
  };
  return { post, searches, expectUnscored, transport };
}

it("continues with plans when one of eight candidates times out twice, and never caches the partial result", async () => {
  const name = scenario.candidates[0].name;
  const failed = new Set([name]);
  const h = await harness(failed, "timeout");
  const first = h.post();
  await vi.advanceTimersByTimeAsync(31_000);
  const response = await first;
  expect(response.status).toBe(200);
  const body = responseSchema.parse(await response.json());
  expect(response.headers.get("X-Result-Cache")).toBe("miss");
  expect(body.llm).toBe("live");
  expect(body.plans).toHaveLength(2);
  expect(body.plans.every(plan => plan.replacement !== name)).toBe(true);
  expect(body.disclaimers.filter(text => text.startsWith("Qloo could not be reached"))).toEqual([
    `Qloo could not be reached for 1 act in this run (${name}); they were not scored.`,
  ]);
  expect(body.not_in_catalog).not.toContain(name);
  expect(body.needs_input.some(item => item.name === name)).toBe(false);
  expect(body.trace.find(row => row.tool === "resolve_acts")).toMatchObject({ status: "ok", result_count: 11,
    params: { by: "server", resolution_status: "partial", lookup_failed_count: 1 } });
  expect(h.searches(name)).toHaveLength(2);
  h.expectUnscored([name]);
  const input = JSON.parse(send.mock.calls[0][0].messages[0].content);
  expect(input.allowed_replacements).not.toContain(name);
  expect(input.resolutions).toContainEqual({ name, status: "lookup_failed", entities: [] });

  const second = h.post();
  await vi.advanceTimersByTimeAsync(31_000);
  const repeated = await second;
  expect(repeated.status).toBe(200);
  expect(repeated.headers.get("X-Result-Cache")).toBe("miss");
  expect((await repeated.json()).run_id).not.toBe(body.run_id);
  expect(h.searches(name)).toHaveLength(4);
  expect(send).toHaveBeenCalledTimes(2);

  failed.clear();
  const recovered = h.post();
  await vi.advanceTimersByTimeAsync(2_000);
  const recoveredResponse = await recovered;
  expect(recoveredResponse.status).toBe(200);
  const recoveredBody = responseSchema.parse(await recoveredResponse.json());
  expect(recoveredBody.disclaimers.some(text => text.startsWith("Qloo could not be reached"))).toBe(false);
  expect(recoveredBody.plans[0].replacement).toBe(name);
  expect((await h.post()).headers.get("X-Result-Cache")).toBe("hit");
});

it("omits failed lineup acts from promotion and scoring, preserves scenario names and caps the notice at five names", async () => {
  const names = [scenario.lineup[0].name, ...scenario.candidates.slice(0, 6).map(act => act.name)];
  const h = await harness(new Set(names));
  const run = h.post();
  await vi.advanceTimersByTimeAsync(5_000);
  const response = await run;
  expect(response.status).toBe(200);
  const body = responseSchema.parse(await response.json());
  expect(body.plans).toHaveLength(2);
  for (const plan of body.plans) {
    expect(names).not.toContain(plan.replacement);
    expect(names).not.toContain(plan.promoted_act);
    expect(plan.evidence.fit_lineup_audience).toContain("only resolved lineup acts included");
  }
  const notice = body.disclaimers.filter(text => text.startsWith("Qloo could not be reached"));
  expect(notice).toEqual([`Qloo could not be reached for 7 acts in this run (${names.slice(0, 5).join(", ")} and 2 more); they were not scored.`]);
  h.expectUnscored(names);
  const input = JSON.parse(send.mock.calls[0][0].messages[0].content);
  expect(input.allowed_promotions).not.toContain(names[0]);
  expect(input.allowed_replacements).toEqual(scenario.candidates.slice(6).map(act => act.name));
  expect(body.trace.find(row => row.tool === "resolve_acts")?.params.lookup_failed_count).toBe(7);
});

it.each(["network", "http"] as const)("returns HTTP 502 and visitor wording without a model call when the cancelled lookup fails after %s retries", async failure => {
  const name = scenario.cancelled_act.name;
  const h = await harness(new Set([name]), failure);
  const run = h.post();
  await vi.advanceTimersByTimeAsync(3_000);
  const response = await run;
  const body = await response.json();
  expect(response.status).toBe(502);
  expect(body.error).toBe("provider");
  expect(body.message).toBe("Qloo could not be reached for this run. Please try again in a minute.");
  expect(body.trace).toEqual([expect.objectContaining({ tool: "resolve_acts", status: "error", params: expect.objectContaining({ lookup_failed_count: 1 }) })]);
  expect(h.searches(name)).toHaveLength(2);
  expect(send).not.toHaveBeenCalled();
});

it("returns HTTP 502 when every lookup fails after retries", async () => {
  const names = [scenario.cancelled_act.name, ...scenario.lineup.map(act => act.name), ...scenario.candidates.map(act => act.name)];
  const h = await harness(new Set(names));
  const run = h.post();
  await vi.advanceTimersByTimeAsync(4_000);
  const response = await run;
  const body = await response.json();
  expect(response.status).toBe(502);
  expect(body.message).toBe("Qloo could not be reached for this run. Please try again in a minute.");
  expect(body.trace[0]).toMatchObject({ tool: "resolve_acts", status: "error", params: { resolution_status: "failed", lookup_failed_count: names.length } });
  for (const name of names) expect(h.searches(name)).toHaveLength(2);
  expect(send).not.toHaveBeenCalled();
});
