import { describe, expect, it, vi } from "vitest";
import { QlooClient, QlooError } from "../src/lib/qloo/client";
import { parseEntities, parseHeat, resultItems, serialize } from "../src/lib/qloo/parsing";
import { LruCache } from "../src/lib/cache";
import { createQloo, qlooMode } from "../src/lib/qloo";
import { QlooRequests } from "../src/lib/qloo/requests";

describe("Qloo request and parsing shapes", () => {
  it("sorts keys and comma-joins arrays without serialising undefined", () => {
    expect(serialize({ z: ["one", "two"], a: "Bristol, UK", missing: undefined, take: 2 })).toBe("a=Bristol%2C+UK&take=2&z=one%2Ctwo");
    expect(serialize({ b: 2, a: 1 })).toBe(serialize({ a: 1, b: 2 }));
  });
  it("accepts direct/nested entities, alternate IDs and both affinity locations", () => {
    const one = { entity_id: "mock-artist-001", name: "Sample One", affinity: .7 };
    const two = { id: "mock-artist-002", name: "Sample Two", query: { affinity: .4 } };
    expect(parseEntities({ results: [one, two, null, {}] })).toEqual([
      { entity_id: "mock-artist-001", name: "Sample One", affinity: .7 },
      { entity_id: "mock-artist-002", name: "Sample Two", affinity: .4 },
    ]);
    expect(parseEntities({ results: { entities: [one] } })).toHaveLength(1);
    expect(resultItems({ results: { tags: ["sample-tag"] } })).toEqual(["sample-tag"]);
    expect(parseEntities(null)).toEqual([]);
    expect(parseEntities({ results: [{ ...one, affinity: "unknown" }] })[0].affinity).toBeNull();
  });
  it("parses heatmap and orders nested affinities without inventing absent scores", () => {
    expect(parseHeat({ results: { heatmap: [{ location: { name: "Sample region" }, query: { affinity: .8 } }, { geohash: "sample-grid" }] } })).toEqual([
      { label: "Sample region", affinity: .8 }, { label: "", affinity: null },
    ]);
  });
  it("uses GET, private header, expected insight params, no disk or HTTP caching", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ results: { entities: [{ entity_id: "mock-a", name: "Sample A" }, { entity_id: "not-requested", name: "Sample outsider" }] } }));
    const client = new QlooClient("synthetic-test-credential", undefined, transport, new LruCache(), new QlooRequests());
    expect(await client.rank(["mock-a", "mock-b"], ["mock-signal"], "Bristol")).toHaveLength(1);
    const [url, init] = transport.mock.calls[0];
    expect(new URL(String(url)).searchParams.get("filter.results.entities")).toBe("mock-a,mock-b");
    expect(new URL(String(url)).searchParams.get("signal.interests.entities")).toBe("mock-signal");
    expect(new URL(String(url)).searchParams.get("signal.location.query")).toBe("Bristol");
    expect(init).toMatchObject({ method: "GET", headers: { "X-Api-Key": "synthetic-test-credential" }, cache: "no-store", redirect: "error" });
    await client.rank(["mock-a", "mock-b"], ["mock-signal"], "Bristol");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each([500, 503])("retries status %i exactly once after 300 ms", async status => {
    vi.useFakeTimers();
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status })).mockResolvedValueOnce(Response.json({ results: [] }));
    const result = new QlooClient("synthetic", undefined, transport, new LruCache(), new QlooRequests()).search("Sample One");
    await vi.advanceTimersByTimeAsync(299);
    expect(transport).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual([]);
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it("does not retry a second 5xx", async () => {
    vi.useFakeTimers();
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 503 }));
    const result = new QlooClient("synthetic", undefined, transport, new LruCache(), new QlooRequests()).search("Sample");
    const failure = expect(result).rejects.toMatchObject({ code: "http", status: 503 });
    await vi.advanceTimersByTimeAsync(300);
    await failure;
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it("returns typed HTTP/parse/network/abort errors and never retries 401", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));
    await expect(new QlooClient("synthetic", undefined, transport, new LruCache(), new QlooRequests()).search("Sample")).rejects.toMatchObject({ code: "http", status: 401 });
    expect(transport).toHaveBeenCalledTimes(1);
    await expect(new QlooClient("synthetic", undefined, vi.fn().mockResolvedValue(new Response("not json")), new LruCache(), new QlooRequests()).search("Sample")).rejects.toMatchObject({ code: "parse" });
    await expect(new QlooClient("synthetic", undefined, vi.fn().mockRejectedValue(new Error("offline")), new LruCache(), new QlooRequests()).search("Sample")).rejects.toBeInstanceOf(QlooError);
    await expect(new QlooClient("synthetic", undefined, transport, new LruCache(), new QlooRequests()).search("Sample", AbortSignal.abort())).rejects.toMatchObject({ code: "aborted" });
  });
  it("enforces the 15-second timeout", async () => {
    // Stub only the timeout clock; all transport remains local and synthetic.
    const abort = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(abort.signal);
    const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("timed out")), { once: true })));
    const promise = new QlooClient("synthetic", undefined, transport, new LruCache(), new QlooRequests()).search("Sample");
    abort.abort();
    await expect(promise).rejects.toMatchObject({ code: "timeout" });
    expect(timeout).toHaveBeenCalledWith(15_000);
    timeout.mockRestore();
  });
  it("uses mock without keys, regardless of a requested live mode", () => {
    const before = process.env.QLOO_MODE;
    process.env.QLOO_MODE = "live";
    expect(qlooMode()).toBe("mock");
    expect(createQloo().source).toBe("mock");
    process.env.QLOO_MODE = before;
  });
});
describe("bounded LRU with 24-hour TTL", () => {
  it("evicts least recently used entries and expires without extending on read", () => {
    let now = 0;
    const cache = new LruCache<number>(2, 86_400_000, () => now);
    cache.set("a", 1); cache.set("b", 2); cache.get("a"); cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    now = 86_400_000;
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("c")).toBeUndefined();
  });
});
