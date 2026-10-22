import { createHash } from "node:crypto";
import { requestSchema, type RescueResponse, type Trace } from "../../../lib/contracts";
import { LruCache } from "../../../lib/cache";
import { RunLimiter, QlooRunLimiter } from "../../../lib/limits";
import { clientKey } from "../../../lib/client-key";
import { runAgent, AgentError } from "../../../lib/agent/loop";
import { llmMode } from "../../../lib/agent/plans";
import { qlooMode } from "../../../lib/qloo";
import { qlooRequests } from "../../../lib/qloo/requests";
import { abortable } from "../../../lib/abort";

export const runtime = "nodejs";
export const maxDuration = 60;
const limiter = new RunLimiter();
const qlooLimiter = new QlooRunLimiter();
const results = new LruCache<RescueResponse>(100);
type PendingRun = { run: Promise<RescueResponse>; trace: Trace[]; controller: AbortController; waiters: number; settled: boolean };
const pending = new Map<string, PendingRun>();

async function waitForRun(entry: PendingRun, signal: AbortSignal) {
  entry.waiters++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (--entry.waiters === 0 && !entry.settled) entry.controller.abort(new AgentError("deadline", "All waiting clients disconnected."));
  };
  signal.addEventListener("abort", release, { once: true });
  if (signal.aborted) release();
  try { return await abortable(entry.run, signal); }
  finally { signal.removeEventListener("abort", release); release(); }
}
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
    controller.signal.throwIfAborted();
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) return failure({ error: "invalid_input", message: "Check input limits and field formats.", issues: parsed.error.issues.map(i => ({ path: i.path.join("."), message: i.message })) }, 400);
    const input = parsed.data;
    // The deployment proxy must replace forwarded headers, not append untrusted values.
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const key = hash(stable({ ...input, resolutions: input.resolutions ?? {}, qloo: qlooMode(), llm: llmMode(), base: process.env.QLOO_BASE_URL ?? "https://hackathon.api.qloo.com" }));
    const cached = results.get(key);
    if (cached) return json(cached, 200, { "X-Result-Cache": "hit" });
    const existing = pending.get(key);
    if (existing && !existing.controller.signal.aborted) {
      trace = existing.trace;
      return json(await Promise.race([waitForRun(existing, controller.signal), aborted]), 200, { "X-Result-Cache": "shared" });
    }
    const ipKey = clientKey(ip);
    // The shared run owns cancellation and cleanup; no individual waiter does.
    const sharedController = new AbortController();
    const sharedTimer = setTimeout(() => sharedController.abort(new AgentError("deadline", "The 50-second deadline was reached. No partial plan was returned.")), Math.max(0, 50_000 - (performance.now() - start)));
    const entry: PendingRun = {
      controller: sharedController, trace, waiters: 0, settled: false,
      // Defer work until the first waiter is registered, including its abort listener.
      run: Promise.resolve().then(async () => {
        const result = await abortable(runAgent(input, sharedController.signal, { trace, startedAt: start,
          reserveQloo: () => !qlooRequests.canStartRun() ? "daily_budget" : !qlooLimiter.reserve(ipKey) ? "client" : undefined,
          reserveModel: () => limiter.reserve(ipKey) }), sharedController.signal);
        sharedController.signal.throwIfAborted();
        if (result.llm !== "fallback") results.set(key, result);
        return result;
      }).finally(() => {
        entry.settled = true;
        clearTimeout(sharedTimer);
        if (pending.get(key) === entry) pending.delete(key);
      }),
    };
    pending.set(key, entry);
    const result = await Promise.race([waitForRun(entry, controller.signal), aborted]);
    // Counts and timings only. Never log names, notes, prompts or provider bodies.
    console.info(JSON.stringify({ candidates: input.scenario.candidates.length, plans: result.plans.length, ms: Math.round(performance.now() - start) }));
    return json(result, 200, { "X-Result-Cache": "miss" });
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
