import { expect, it, vi } from "vitest";
import { QlooClient } from "../src/lib/qloo/client";
import { QlooRequests } from "../src/lib/qloo/requests";
import { LruCache } from "../src/lib/cache";

function client(transport: typeof fetch, requests = new QlooRequests()) {
  return new QlooClient("synthetic", undefined, transport, new LruCache(), requests);
}

it("resolves 30 concurrent searches in FIFO order with rolling and in-flight bounds across clients", async () => {
  vi.useFakeTimers();
  const limit = 3;
  const requests = new QlooRequests(limit);
  const starts: number[] = [];
  const names: string[] = [];
  let active = 0;
  let peak = 0;
  const transport = vi.fn<typeof fetch>().mockImplementation(async url => {
    starts.push(performance.now());
    names.push(new URL(String(url)).searchParams.get("query")!);
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 1_350));
    active--;
    return Response.json({ results: [] });
  });
  const clients = [client(transport, requests), client(transport, requests)];
  const all = Promise.all(Array.from({ length: 30 }, (_, i) => clients[i % 2].search(`Synthetic ${i}`)));
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await all).toHaveLength(30);
  expect(peak).toBe(limit);
  expect(names).toEqual(Array.from({ length: 30 }, (_, i) => `Synthetic ${i}`));
  for (const end of starts) expect(starts.filter(start => start > end - 1_000 && start <= end).length).toBeLessThanOrEqual(limit);
});

it("enforces a rolling second when starts are staggered", async () => {
  vi.useFakeTimers();
  const starts: number[] = [];
  const transport = vi.fn<typeof fetch>().mockImplementation(async () => {
    starts.push(performance.now());
    return Response.json({ results: [] });
  });
  const qloo = client(transport, new QlooRequests(2));
  await qloo.search("First");
  await vi.advanceTimersByTimeAsync(600);
  await qloo.search("Second");
  const pending = Promise.all([qloo.search("Third"), qloo.search("Fourth")]);
  await vi.advanceTimersByTimeAsync(400);
  expect(starts).toEqual([0, 600, 1_000]);
  await vi.advanceTimersByTimeAsync(600);
  await pending;
  expect(starts).toEqual([0, 600, 1_000, 1_600]);
});

it.each(["", "0", "-1", "1.5", "no", "Infinity", "9007199254740992"])("defaults invalid gate limit %j to eight starts per second", async value => {
  vi.stubEnv("QLOO_MAX_PER_SECOND", value);
  vi.useFakeTimers();
  const transport = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ results: [] }));
  const qloo = client(transport);
  const pending = Promise.all(Array.from({ length: 30 }, (_, i) => qloo.search(`Synthetic ${i}`)));
  expect(transport).toHaveBeenCalledTimes(8);
  await vi.advanceTimersByTimeAsync(999);
  expect(transport).toHaveBeenCalledTimes(8);
  await vi.advanceTimersByTimeAsync(1);
  expect(transport).toHaveBeenCalledTimes(16);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(await pending).toHaveLength(30);
});

it.each([
  [null, 1_000], ["", 1_000], ["no", 1_000], ["Infinity", 1_000], ["-2", 1_000],
  ["0.3", 1_000], ["1", 1_000], ["1.5", 1_500], ["99", 5_000],
] as const)("waits for bounded 429 reset %j before retrying", async (reset, ms) => {
  vi.useFakeTimers();
  const transport = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 429, headers: reset === null ? {} : { "x-second-ratelimit-reset": reset } }))
    .mockResolvedValueOnce(Response.json({ results: [] }));
  const result = client(transport).search("Synthetic");
  await vi.advanceTimersByTimeAsync(ms - 1);
  expect(transport).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toEqual([]);
  expect(transport).toHaveBeenCalledTimes(2);
});

it("fails as HTTP 429 after three attempts and counts every sent retry", async () => {
  vi.useFakeTimers();
  const requests = new QlooRequests(8, 3);
  const transport = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 429 }));
  const failure = expect(client(transport, requests).search("Synthetic")).rejects.toMatchObject({ code: "http", status: 429 });
  await vi.advanceTimersByTimeAsync(2_000);
  await failure;
  expect(transport).toHaveBeenCalledTimes(3);
  expect(requests.canStartRun()).toBe(false);
});

it("routes retries through the gate, including the 300 ms 5xx retry", async () => {
  vi.useFakeTimers();
  const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ results: [] }));
  const result = client(transport, new QlooRequests(1)).search("Synthetic");
  await vi.advanceTimersByTimeAsync(999);
  expect(transport).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toEqual([]);
  expect(transport).toHaveBeenCalledTimes(2);
});

it("aborts queued work without sending it or consuming budget and lets the next FIFO entry run", async () => {
  vi.useFakeTimers();
  const requests = new QlooRequests(1, 3);
  const transport = vi.fn<typeof fetch>().mockImplementation(async () => {
    await new Promise(resolve => setTimeout(resolve, 1_500));
    return Response.json({ results: [] });
  });
  const qloo = client(transport, requests);
  const first = qloo.search("First");
  const controller = new AbortController();
  const queued = qloo.search("Never sent", controller.signal);
  const failure = expect(queued).rejects.toMatchObject({ code: "aborted" });
  const third = qloo.search("Third");
  controller.abort();
  await failure;
  await vi.advanceTimersByTimeAsync(3_000);
  await Promise.all([first, third]);
  expect(transport.mock.calls.map(([url]) => new URL(String(url)).searchParams.get("query"))).toEqual(["First", "Third"]);
  expect(requests.canStartRun()).toBe(true);
});

it("aborts a 429 backoff without retrying", async () => {
  vi.useFakeTimers();
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 429 }));
  const controller = new AbortController();
  const result = client(transport).search("Synthetic", controller.signal);
  const failure = expect(result).rejects.toMatchObject({ code: "aborted" });
  await vi.advanceTimersByTimeAsync(500);
  controller.abort();
  await failure;
  await vi.advanceTimersByTimeAsync(2_000);
  expect(transport).toHaveBeenCalledTimes(1);
});

it("counts sent HTTP requests but not response-cache hits, and resets the budget at UTC midnight", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-10-21T23:59:00Z"));
  const requests = new QlooRequests(8, 2);
  const transport = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ results: [] }));
  const qloo = client(transport, requests);
  await qloo.search("First");
  for (let i = 0; i < 5; i++) await qloo.search("First");
  expect(transport).toHaveBeenCalledTimes(1);
  expect(requests.canStartRun()).toBe(true);
  await qloo.search("Second");
  expect(requests.canStartRun()).toBe(false);
  // Admitted runs may continue even when the budget has been reached.
  await qloo.search("Third");
  expect(transport).toHaveBeenCalledTimes(3);
  vi.setSystemTime(Date.parse("2026-10-22T00:00:00Z"));
  expect(requests.canStartRun()).toBe(true);
});

it.each(["", "0", "-1", "1.5", "no", "Infinity", "9007199254740992"])("defaults invalid daily request budget %j to 2000", value => {
  vi.stubEnv("QLOO_CALLS_PER_DAY", value);
  const requests = new QlooRequests();
  for (let i = 0; i < 2_000; i++) {
    expect(requests.canStartRun()).toBe(true);
    requests.recordSent();
  }
  expect(requests.canStartRun()).toBe(false);
});

it("shares the default gate across independently constructed live clients", async () => {
  vi.useFakeTimers();
  const transport = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ results: [] }));
  const a = new QlooClient("synthetic", undefined, transport, new LruCache());
  const b = new QlooClient("synthetic", undefined, transport, new LruCache());
  const pending = Promise.all(Array.from({ length: 16 }, (_, i) => (i % 2 ? a : b).search(`Synthetic ${i}`)));
  expect(transport).toHaveBeenCalledTimes(8);
  await vi.advanceTimersByTimeAsync(999);
  expect(transport).toHaveBeenCalledTimes(8);
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toHaveLength(16);
});
