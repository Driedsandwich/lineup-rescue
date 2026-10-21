import { createHash } from "node:crypto";
import { requestSchema, type RescueResponse, type Trace } from "../../../lib/contracts";
import { LruCache } from "../../../lib/cache";
import { RunLimiter } from "../../../lib/limits";
import { runAgent, AgentError } from "../../../lib/agent/loop";
import { llmMode } from "../../../lib/agent/plans";
import { qlooMode } from "../../../lib/qloo";

export const runtime = "nodejs";
export const maxDuration = 60;
const limiter = new RunLimiter();
const results = new LruCache<RescueResponse>(100);
const pending = new Map<string, { run: Promise<RescueResponse>; trace: Trace[] }>();
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}
async function readBody(request: Request, signal: AbortSignal): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > 65_536) throw new Error("body_size");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("body_json");
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) { await reader.cancel(); throw new Error("body_size"); }
      chunks.push(value);
    }
  } finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export async function POST(request: Request) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  request.signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(), 50_000);
  const start = performance.now();
  let trace: Trace[] = [];
  const failure = (body: Record<string, unknown>, status: number, headers: Record<string, string> = {}) => json({ ...body, trace: [...trace] }, status, headers);
  let abortListener: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => reject(new AgentError("deadline", "The 50-second deadline was reached. No partial plan was returned."));
      controller.signal.addEventListener("abort", abortListener, { once: true });
    });
    if (request.signal.aborted) controller.abort();
    const raw = await Promise.race([readBody(request, controller.signal), aborted]);
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) return failure({ error: "invalid_input", message: "Check input limits and field formats.", issues: parsed.error.issues.map(i => ({ path: i.path.join("."), message: i.message })) }, 400);
    const input = parsed.data;
    // The deployment proxy must replace forwarded headers, not append untrusted values.
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const key = hash(stable({ ...input, resolutions: input.resolutions ?? {}, qloo: qlooMode(), llm: llmMode(), base: process.env.QLOO_BASE_URL ?? "https://hackathon.api.qloo.com" }));
    const cached = results.get(key);
    if (cached) return json(cached, 200, { "X-Result-Cache": "hit" });
    const existing = pending.get(key);
    if (existing) {
      trace = existing.trace;
      return json(await Promise.race([existing.run, aborted]), 200, { "X-Result-Cache": "shared" });
    }
    const run = runAgent(input, controller.signal, { trace, startedAt: start, reserveModel: () => limiter.reserve(hash(ip)) }).then(result => {
      controller.signal.throwIfAborted();
      if (result.llm !== "fallback") results.set(key, result);
      return result;
    });
    pending.set(key, { run, trace });
    try {
      const result = await Promise.race([run, aborted]);
      // Counts and timings only. Never log names, notes, prompts or provider bodies.
      console.info(JSON.stringify({ candidates: input.scenario.candidates.length, plans: result.plans.length, ms: Math.round(performance.now() - start) }));
      return json(result, 200, { "X-Result-Cache": "miss" });
    } finally { pending.delete(key); }
  } catch (error) {
    if (error instanceof AgentError) {
      if (error.trace.length) trace = error.trace;
      return failure({ error: error.code, message: error.message }, error.code === "deadline" ? 504 : 502);
    }
    if (controller.signal.aborted) return failure({ error: "deadline", message: "The 50-second deadline was reached." }, 504);
    if (error instanceof SyntaxError) return failure({ error: "invalid_json", message: "Send a valid JSON request body." }, 400);
    if (error instanceof Error && error.message === "body_json") return failure({ error: "invalid_json", message: "Send a valid JSON request body." }, 400);
    if (error instanceof Error && error.message === "body_size") return failure({ error: "body_too_large", message: "Request body exceeds 64 KiB." }, 400);
    return failure({ error: "run_failed", message: "The rescue could not be completed. Review inputs and server configuration." }, 502);
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", cancel);
    if (abortListener) controller.signal.removeEventListener("abort", abortListener);
  }
}
