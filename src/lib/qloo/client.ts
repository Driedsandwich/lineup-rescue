import "server-only";
import { LruCache } from "../cache";
import { parseEntities, parseHeat, serialize } from "./parsing";
import { qlooRequests } from "./requests";
import type { Params, Qloo } from "./types";

export class QlooError extends Error {
  constructor(public code: "http" | "timeout" | "network" | "parse" | "aborted", public status?: number) {
    super(`Qloo ${code}${status ? ` (${status})` : ""}`);
    this.name = "QlooError";
  }
}
const cache = new LruCache<unknown>(500);
function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new QlooError("aborted")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
function resetMs(value: string | null) {
  const seconds = Number(value);
  return Math.min(5, Math.max(1, Number.isFinite(seconds) ? seconds : 1)) * 1_000;
}
export class QlooClient implements Qloo {
  readonly source = "live" as const;
  constructor(private apiKey: string, private baseUrl = "https://hackathon.api.qloo.com", private transport: typeof fetch = fetch, private responseCache = cache, private requests = qlooRequests) {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("Qloo base URL must use HTTPS without embedded credentials.");
  }
  async get(path: "/search" | "/v2/insights", params: Params, signal?: AbortSignal): Promise<unknown> {
    const key = `${this.baseUrl}${path}?${serialize(params)}`;
    const cached = this.responseCache.get(key);
    if (cached !== undefined) return cached;
    let rateRetries = 0;
    let serverRetries = 0;
    let networkRetries = 0;
    while (true) {
      try {
        const result = await this.requests.run(async () => {
          // Queue time is governed by the caller's deadline. Each actual HTTP
          // attempt retains its own 15-second timeout, including body parsing.
          const timeout = AbortSignal.timeout(15_000);
          const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
          try {
            combined.throwIfAborted();
            this.requests.recordSent();
            const response = await this.transport(key, { method: "GET", headers: { "X-Api-Key": this.apiKey }, signal: combined, cache: "no-store", redirect: "error" });
            if (!response.ok) {
              const failure = { status: response.status, reset: response.headers.get("x-second-ratelimit-reset") };
              await response.body?.cancel();
              return failure;
            }
            let body: unknown;
            try { body = await response.json(); } catch {
              if (combined.aborted) throw new QlooError(signal?.aborted ? "aborted" : "timeout");
              throw new QlooError("parse");
            }
            combined.throwIfAborted();
            if (!body || typeof body !== "object" || (body as { success?: boolean }).success === false) throw new QlooError("parse");
            return { body };
          } catch (error) {
            if (error instanceof QlooError) throw error;
            if (combined.aborted) throw new QlooError(signal?.aborted ? "aborted" : "timeout");
            throw new QlooError("network");
          }
        }, signal);
        if ("body" in result) {
          this.responseCache.set(key, result.body);
          return result.body;
        }
        if (result.status === 429 && rateRetries < 2) {
          rateRetries++;
          await wait(resetMs(result.reset), signal);
        } else if (result.status >= 500 && serverRetries < 1) {
          serverRetries++;
          await wait(300, signal);
        } else throw new QlooError("http", result.status);
      } catch (error) {
        if (signal?.aborted) throw new QlooError("aborted");
        const failure = error instanceof QlooError ? error : new QlooError("network");
        if ((failure.code === "network" || failure.code === "timeout") && networkRetries < 1) {
          networkRetries++;
          await wait(300, signal);
        } else throw failure;
      }
    }
  }
  async search(name: string, signal?: AbortSignal) {
    return parseEntities(await this.get("/search", { query: name, types: ["urn:entity:artist"], take: 5 }, signal)).slice(0, 5);
  }
  async rank(options: string[], signals: string[], city: string, signal?: AbortSignal) {
    if (!options.length || !signals.length) return [];
    return parseEntities(await this.get("/v2/insights", {
      "filter.type": "urn:entity:artist", "filter.results.entities": options,
      "signal.interests.entities": signals, "signal.location.query": city, take: options.length,
    }, signal)).filter(item => options.includes(item.entity_id)).slice(0, options.length);
  }
  async heat(id: string, region: string, signal?: AbortSignal) {
    return parseHeat(await this.get("/v2/insights", {
      "filter.type": "urn:heatmap", "signal.interests.entities": [id], "filter.location.query": region, take: 3,
    }, signal)).slice(0, 3);
  }
}
