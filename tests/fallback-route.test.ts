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
