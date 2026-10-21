import { afterEach, beforeEach, expect, it, vi } from "vitest";
import sample from "../samples/scenario.json";
import { POST } from "../src/app/api/rescue/route";
import { responseSchema } from "../src/lib/contracts";
import * as plans from "../src/lib/agent/plans";
import * as qloo from "../src/lib/qloo";
import { MockQloo } from "../src/lib/qloo/mock";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: send }; } }));

function request(name: string, signal?: AbortSignal) {
  return new Request("http://localhost/api/rescue", { method: "POST", signal, headers: { "Content-Type": "application/json", "x-forwarded-for": name }, body: JSON.stringify({ mode: "qloo", scenario: { ...sample, festival_name: name } }) });
}
beforeEach(() => {
  send.mockReset();
  vi.spyOn(plans, "llmMode").mockReturnValue("live");
});
afterEach(() => vi.restoreAllMocks());

it.each(["partial", "corrected", "fallback"])("retains rejection details through the HTTP route with %s acceptance", async kind => {
  const valid = {
    id: "keep-C", title: "Synthetic direct swap", type: "direct_swap", replacement: sample.candidates[0].name,
    promoted_act: null, rationale: "Verify production and fees.", caveats: ["Confirm timing."],
  };
  const invalid = { ...valid, id: "drop-A", replacement: "Sample Glass Meadow" };
  const announcement = { short_post: "Programme under review.", email_subject: "Programme update", email_body: "Check official channels for confirmed changes." };
  const submit = (entries: typeof valid[]) => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "submit", name: "submit_rescue_plan", input: { plans: entries, announcement, refund_checklist: [] } }] });
  send.mockResolvedValueOnce(submit(kind === "partial" ? [invalid, valid] : [invalid]));
  if (kind === "corrected") send.mockImplementationOnce(async params => {
    expect(JSON.parse(params.messages.at(-1).content[0].content)).toEqual({ error: "Ineligible replacement", plan_id: "drop-A" });
    return submit([valid]);
  });
  if (kind === "fallback") send.mockResolvedValueOnce({ stop_reason: "refusal", content: [] });
  const response = await POST(request(`synthetic rejection ${kind}`));
  expect(response.status).toBe(200);
  const body = responseSchema.parse(await response.json());
  expect(body.llm).toBe(kind === "fallback" ? "fallback" : "live");
  expect(body.trace).toContainEqual({ tool: "submit_rescue_plan", status: "error", params: { reason: "Ineligible replacement", plan_id: "drop-A" }, result_count: 0, ms: 0 });
  expect(send).toHaveBeenCalledTimes(kind === "partial" ? 1 : 2);
  if (kind !== "fallback") expect(body.plans.map(p => p.id)).toEqual(["keep-C"]);
  if (kind === "partial") expect(body.disclaimers).toContain("One suggested plan was dropped: Ineligible replacement");
  expect(body.refund_checklist.map(t => t.ticket_type)).toEqual(sample.ticket_types);
});

it("returns HTTP 200 at the 40-second model deadline rather than a traceless 504", async () => {
  vi.useFakeTimers();
  send.mockImplementation(() => new Promise(() => {}));
  const run = POST(request("synthetic deadline route"));
  await vi.advanceTimersByTimeAsync(40_000);
  const response = await run;
  expect(response.status).toBe(200);
  const body = responseSchema.parse(await response.json());
  expect(body.llm).toBe("fallback");
  expect(body.trace).toContainEqual(expect.objectContaining({ tool: "model_turn", status: "error", ms: 40_000 }));
  expect(send.mock.calls[0][1].signal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not cache fallback; the next identical request can produce and cache a live answer", async () => {
  send.mockRejectedValueOnce(new Error("synthetic-private-provider-body"));
  const first = await POST(request("synthetic cache retry"));
  const fallback = responseSchema.parse(await first.json());
  expect(first.status).toBe(200);
  expect(first.headers.get("X-Result-Cache")).toBe("miss");
  expect(fallback.llm).toBe("fallback");
  send.mockResolvedValue({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "submit", name: "submit_rescue_plan", input: {
    plans: [], announcement: fallback.announcement, refund_checklist: fallback.refund_checklist,
  } }] });
  const second = await POST(request("synthetic cache retry"));
  const live = responseSchema.parse(await second.json());
  expect(second.status).toBe(200);
  expect(second.headers.get("X-Result-Cache")).toBe("miss");
  expect(live.llm).toBe("live");
  expect(live.run_id).not.toBe(fallback.run_id);
  expect(send).toHaveBeenCalledTimes(2);
  const third = await POST(request("synthetic cache retry"));
  expect(third.headers.get("X-Result-Cache")).toBe("hit");
  expect((await third.json()).run_id).toBe(live.run_id);
  expect(send).toHaveBeenCalledTimes(2);
});

it("includes safe collected trace when live Qloo pre-resolution is unavailable", async () => {
  const client = { source: "live" as const, search: vi.fn(async () => { throw new Error("synthetic-private-qloo-body"); }), rank: vi.fn(async () => []), heat: vi.fn(async () => []) };
  vi.spyOn(qloo, "createQloo").mockReturnValue(client);
  const response = await POST(request("synthetic qloo unavailable"));
  const body = await response.json();
  expect(response.status).toBe(502);
  expect(body.trace).toEqual([expect.objectContaining({ tool: "resolve_acts", status: "error", params: expect.objectContaining({ by: "server" }) })]);
  expect(JSON.stringify(body)).not.toContain("synthetic-private-qloo-body");
  expect(send).not.toHaveBeenCalled();
});

it("retains model and tool trace if Qloo stalls through the hard request deadline", async () => {
  vi.useFakeTimers();
  send.mockResolvedValue({ stop_reason: "refusal", content: [] });
  vi.spyOn(MockQloo.prototype, "rank").mockImplementation(() => new Promise(() => {}));
  const run = POST(request("synthetic request deadline"));
  await vi.advanceTimersByTimeAsync(50_000);
  const response = await run;
  const body = await response.json();
  expect(response.status).toBe(504);
  expect(body.trace).toEqual(expect.arrayContaining([
    expect.objectContaining({ tool: "resolve_acts" }),
    expect.objectContaining({ tool: "model_turn", status: "error" }),
    expect.objectContaining({ tool: "fallback", params: expect.objectContaining({ reason: "refusal" }) }),
  ]));
});

it("includes an empty trace for errors before any agent work starts", async () => {
  const response = await POST(new Request("http://localhost/api/rescue", { method: "POST", body: "invalid json" }));
  expect(response.status).toBe(400);
  expect((await response.json()).trace).toEqual([]);
});
