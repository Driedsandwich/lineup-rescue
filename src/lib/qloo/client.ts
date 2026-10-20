import "server-only";
import { LruCache } from "../cache";
import { parseEntities, parseHeat, serialize } from "./parsing";
import type { Params, Qloo } from "./types";

export class QlooError extends Error {
  constructor(public code: "http" | "timeout" | "network" | "parse" | "aborted", public status?: number) {
    super(`Qloo ${code}${status ? ` (${status})` : ""}`);
    this.name = "QlooError";
  }
}
const cache = new LruCache<unknown>(500);
export class QlooClient implements Qloo {
  readonly source = "live" as const;
  constructor(private apiKey: string, private baseUrl = "https://hackathon.api.qloo.com", private transport: typeof fetch = fetch, private responseCache = cache) {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("Qloo base URL must use HTTPS without embedded credentials.");
  }
  async get(path: "/search" | "/v2/insights", params: Params, signal?: AbortSignal): Promise<unknown> {
    const key = `${this.baseUrl}${path}?${serialize(params)}`;
    const cached = this.responseCache.get(key);
    if (cached !== undefined) return cached;
    for (let attempt = 0; attempt < 2; attempt++) {
      const timeout = AbortSignal.timeout(15_000);
      const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
      try {
        combined.throwIfAborted();
        const response = await this.transport(key, { method: "GET", headers: { "X-Api-Key": this.apiKey }, signal: combined, cache: "no-store", redirect: "error" });
        if (!response.ok) {
          if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
            await response.body?.cancel();
            await new Promise<void>((resolve, reject) => {
              const abort = () => { clearTimeout(timer); reject(new QlooError("aborted")); };
              const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, 300);
              signal?.addEventListener("abort", abort, { once: true });
              if (signal?.aborted) abort();
            });
            continue;
          }
          throw new QlooError("http", response.status);
        }
        let body: unknown;
        try { body = await response.json(); } catch {
          if (combined.aborted) throw new QlooError(signal?.aborted ? "aborted" : "timeout");
          throw new QlooError("parse");
        }
        if (!body || typeof body !== "object" || (body as { success?: boolean }).success === false) throw new QlooError("parse");
        this.responseCache.set(key, body);
        return body;
      } catch (error) {
        if (error instanceof QlooError) throw error;
        if (combined.aborted) throw new QlooError(signal?.aborted ? "aborted" : "timeout");
        throw new QlooError("network");
      }
    }
    throw new QlooError("http");
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
