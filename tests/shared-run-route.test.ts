import { afterEach, beforeEach, expect, it, vi } from "vitest";
import sample from "../samples/scenario.json";
import { responseSchema } from "../src/lib/contracts";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: send }; } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const submission = { stop_reason: "tool_use", content: [{ type: "tool_use", id: "synthetic-submit", name: "submit_rescue_plan", input: {
  plans: [{ id: "A", title: "Synthetic swap", type: "direct_swap", replacement: sample.candidates[0].name, promoted_act: null,
    rationale: "Verify production and fees.", caveats: ["Confirm timing."] }],
  announcement: { short_post: "Synthetic draft", email_subject: "Synthetic update", email_body: "Synthetic body" }, refund_checklist: [],
} }] };

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  send.mockReset().mockResolvedValue(submission);
  const plans = await import("../src/lib/agent/plans");
  vi.spyOn(plans, "llmMode").mockReturnValue("live");
});
afterEach(() => vi.restoreAllMocks());

async function harness(hold: "qloo" | "model" = "qloo") {
  const release = deferred<void>();
  const ready = deferred<void>();
  const signals: AbortSignal[] = [];
  const transport = vi.fn<typeof fetch>().mockImplementation(async (raw, init) => {
    const signal = init!.signal!;
    signals.push(signal);
    const url = new URL(String(raw));
    if (url.pathname === "/search") {
      if (hold === "qloo") {
        ready.resolve();
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          void release.promise.then(() => { signal.removeEventListener("abort", abort); resolve(); });
          if (signal.aborted) abort();
        });
      }
      const name = url.searchParams.get("query")!;
      return Response.json({ results: [{ entity_id: `synthetic-${name}`, name }] });
    }
    if (url.searchParams.get("filter.type") === "urn:heatmap") return Response.json({ results: { heatmap: [{ name: "Synthetic area", affinity: .8 }] } });
    return Response.json({ results: url.searchParams.get("filter.results.entities")!.split(",").map(entity_id => ({ entity_id, name: "Synthetic act", affinity: .8 })) });
  });
  const qloo = await import("../src/lib/qloo");
  const { QlooClient } = await import("../src/lib/qloo/client");
  vi.spyOn(qloo, "qlooMode").mockReturnValue("live");
  vi.spyOn(qloo, "createQloo").mockImplementation(() => new QlooClient("synthetic", undefined, transport));
  if (hold === "model") send.mockImplementationOnce(() => { ready.resolve(); return release.promise.then(() => submission); });
  const { POST } = await import("../src/app/api/rescue/route");
  const { LruCache } = await import("../src/lib/cache");
  const lookup = vi.spyOn(LruCache.prototype, "get");
  const post = (signal?: AbortSignal) => POST(new Request("http://localhost/api/rescue", { method: "POST", signal,
    headers: { "Content-Type": "application/json", "x-forwarded-for": "192.0.2.1" }, body: JSON.stringify({ mode: "qloo", scenario: sample }) }));
  const firstClient = new AbortController();
  const secondClient = new AbortController();
  const first = post(firstClient.signal);
  await vi.advanceTimersByTimeAsync(1_000);
  await ready.promise;
  lookup.mockClear();
  const second = post(secondClient.signal);
  await vi.advanceTimersByTimeAsync(0);
  expect(lookup).toHaveBeenCalled(); // The second request has joined the pending run.
  return { first, second, firstClient, secondClient, post, release, signals, transport };
}

it.each(["qloo", "model"] as const)("keeps a shared run and its cache alive when the first client leaves during %s work", async hold => {
  const h = await harness(hold);
  h.firstClient.abort();
  expect((await h.first).status).toBe(504);
  expect(h.signals.every(signal => !signal.aborted)).toBe(true);
  if (hold === "model") expect(send.mock.calls[0][1].signal.aborted).toBe(false);
  h.release.resolve();
  await vi.advanceTimersByTimeAsync(1_000);
  const response = await h.second;
  expect(response.status).toBe(200);
  expect(response.headers.get("X-Result-Cache")).toBe("shared");
  const body = responseSchema.parse(await response.json());
  expect(body.plans).toHaveLength(1);
  expect(send).toHaveBeenCalledTimes(1);
  const cached = await h.post();
  expect(cached.headers.get("X-Result-Cache")).toBe("hit");
  expect((await cached.json()).run_id).toBe(body.run_id);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["qloo", "model"] as const)("aborts shared %s work only after both clients leave and never sends further calls", async hold => {
  const h = await harness(hold);
  h.firstClient.abort();
  expect((await h.first).status).toBe(504);
  expect(h.signals.every(signal => !signal.aborted)).toBe(true);
  h.secondClient.abort();
  expect((await h.second).status).toBe(504);
  expect(h.signals.every(signal => signal.aborted)).toBe(true);
  if (hold === "model") expect(send.mock.calls[0][1].signal.aborted).toBe(true);
  const counts = [h.transport.mock.calls.length, send.mock.calls.length];
  h.release.resolve(); // Even a late response from a transport ignoring abort cannot resume work.
  await vi.advanceTimersByTimeAsync(60_000);
  expect([h.transport.mock.calls.length, send.mock.calls.length]).toEqual(counts);
  expect(vi.getTimerCount()).toBe(0);
  const retry = h.post();
  await vi.advanceTimersByTimeAsync(1_000);
  const response = await retry;
  expect(response.status).toBe(200);
  expect(response.headers.get("X-Result-Cache")).toBe("miss");
  expect(responseSchema.parse(await response.json()).plans).toHaveLength(1);
});

it("keeps the original 50-second deadline when a later client remains connected", async () => {
  const h = await harness();
  await vi.advanceTimersByTimeAsync(24_000);
  h.firstClient.abort();
  expect((await h.first).status).toBe(504);
  await vi.advanceTimersByTimeAsync(25_000);
  const response = await h.second;
  expect(response.status).toBe(504);
  expect((await response.json()).error).toBe("deadline");
  expect(h.signals.every(signal => signal.aborted)).toBe(true);
  expect(send).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("returns visitor wording and the error trace after synthetic Qloo 5xx retries fail", async () => {
  const qloo = await import("../src/lib/qloo");
  const { QlooClient } = await import("../src/lib/qloo/client");
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
  vi.spyOn(qloo, "createQloo").mockImplementation(() => new QlooClient("synthetic", undefined, transport));
  const { POST } = await import("../src/app/api/rescue/route");
  const run = POST(new Request("http://localhost/api/rescue", { method: "POST", body: JSON.stringify({ mode: "qloo", scenario: sample }) }));
  await vi.advanceTimersByTimeAsync(5_000);
  const response = await run;
  const body = await response.json();
  expect(response.status).toBe(502);
  expect(body.error).toBe("provider");
  expect(body.message).toBe("Qloo could not be reached for this run. Please try again in a minute.");
  expect(JSON.stringify(body)).not.toMatch(/mock mode|synthetic fallback/);
  expect(body.trace).toEqual([expect.objectContaining({ tool: "resolve_acts", status: "error", params: expect.objectContaining({ by: "server" }) })]);
  const urls = transport.mock.calls.map(([url]) => String(url));
  expect(new Set(urls).size).toBeGreaterThan(0);
  for (const url of new Set(urls)) expect(urls.filter(value => value === url)).toHaveLength(2);
  expect(send).not.toHaveBeenCalled();
});
