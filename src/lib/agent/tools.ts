import "server-only";
import { z } from "zod";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { submissionSchema, type RescueRequest, type NeedsInput, type Trace } from "../contracts";
import type { Entity, Heat, Qloo } from "../qloo/types";
import { QlooError } from "../qloo/client";
import { filterCandidates } from "./constraints";
import { abortable } from "../abort";

const text = z.string().min(1).max(200);
const ids = z.array(text).min(1).max(32);
export const toolSchemas = {
  resolve_acts: z.strictObject({ names: z.array(text).min(1).max(33) }),
  rank_against_audience: z.strictObject({ option_ids: ids, signal_ids: ids, city: text }),
  local_heat: z.strictObject({ entity_id: text, region: text }),
  submit_rescue_plan: submissionSchema,
};
export type ToolName = keyof typeof toolSchemas;
const descriptions: Record<ToolName, string> = {
  resolve_acts: "Resolve scenario act names only. Never guess ambiguous matches; ask the user to choose. Excluded acts cannot be queried.",
  rank_against_audience: "Rank only resolved eligible candidate or lineup IDs against resolved audience IDs in the scenario city. Returns bounded affinity evidence, not ticket forecasts.",
  local_heat: "Inspect a resolved eligible act's aggregate audience around the scenario city. Not availability or ticket sales.",
  submit_rescue_plan: "Submit decisions and draft copy only: up to 3 plans (rationale <= 600 characters, up to 4 caveats each <= 200), announcement (post <= 280, subject <= 120, body <= 1200), and one checklist per ticket type (up to 6 items each <= 200). The server supplies evidence, metadata, trace and disclaimers and fetches any missing evidence. Only eligible replacements; no invented refund policy.",
};
// Strict tool schemas reject string/number constraints and complex array constraints.
// Strip them from what is sent; the zod schemas above still validate every input server-side.
const UNSUPPORTED = new Set(["$schema", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "maxItems", "pattern"]);
export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(Object.entries(schema).flatMap(([key, value]): [string, unknown][] => {
    if (key === "properties" && value && typeof value === "object")
      return [[key, Object.fromEntries(Object.entries(value).map(([name, child]) => [name, strictSchema(child)]))]];
    if (UNSUPPORTED.has(key) || (key === "minItems" && typeof value === "number" && value > 1)) return [];
    return [[key, strictSchema(value)]];
  }));
}
export function definitions(mode: RescueRequest["mode"], canResolve = true): Tool[] {
  const names: ToolName[] = mode === "baseline" ? ["submit_rescue_plan"] : [...(canResolve ? ["resolve_acts" as const] : []), "rank_against_audience", "local_heat", "submit_rescue_plan"];
  return names.map(name => ({
    name, description: descriptions[name], strict: true,
    input_schema: strictSchema(z.toJSONSchema(toolSchemas[name], { target: "draft-7" })) as Tool.InputSchema,
  }));
}
export type Resolution = { name: string; status: "matched" | "ambiguous" | "not_found"; entities: Entity[] };
export type ToolResult = { status: Trace["status"]; results: unknown[]; error?: string };
export type Ranking = { options: string[]; signals: string[]; results: Entity[] };

export class ToolContext {
  readonly filtered;
  readonly names: Set<string>;
  readonly resolved = new Map<string, Entity>();
  readonly resolutions = new Map<string, Resolution>();
  readonly rankings: Ranking[] = [];
  readonly heats = new Map<string, Heat[]>();
  private calls = 0;
  constructor(readonly request: RescueRequest, readonly qloo: Qloo, readonly signal: AbortSignal, readonly trace: Trace[] = []) {
    this.filtered = filterCandidates(request.scenario.candidates);
    this.names = new Set([request.scenario.cancelled_act.name, ...request.scenario.lineup.map(a => a.name), ...this.filtered.eligible.map(a => a.name)]);
  }
  get needsInput(): NeedsInput[] {
    return [...this.resolutions.values()].filter(r => r.status === "ambiguous").map(r => ({
      name: r.name, options: r.entities.map(e => ({ entity_id: e.entity_id, label: `${e.name} (${e.entity_id.slice(0, 8)}…)`.slice(0, 200) })),
    }));
  }
  get notInCatalog() { return [...this.resolutions.values()].filter(r => r.status === "not_found").map(r => r.name); }
  get canResolve() { return [...this.names].some(name => !this.resolutions.has(name)); }
  private known(id: string) { return [...this.resolved.values()].some(e => e.entity_id === id); }
  private redact(params: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(params).map(([key, value]) => [key,
      key.includes("id") ? (Array.isArray(value) ? value.map(id => `${String(id).slice(0, 8)}…`) : `${String(value).slice(0, 8)}…`) : value,
    ]));
  }
  async execute(name: string, raw: unknown, by?: "server", signal = this.signal): Promise<ToolResult> {
    const start = performance.now();
    let params: Record<string, unknown> = {};
    let result: ToolResult;
    try {
      signal.throwIfAborted();
      if (++this.calls > 60) throw new Error("Tool call budget exhausted");
      if (this.request.mode === "baseline") throw new Error("Qloo tools are unavailable in baseline mode");
      switch (name) {
        case "resolve_acts": {
          const input = toolSchemas.resolve_acts.parse(raw);
          params = input;
          if (input.names.some(n => !this.names.has(n))) throw new Error("Only scenario act names are allowed");
          const resolved = await Promise.all([...new Set(input.names)].map(async act => {
            const existing = this.resolutions.get(act);
            if (existing) return existing;
            let entities: Entity[];
            try { entities = await abortable(this.qloo.search(act, signal), signal); }
            catch (error) {
              // Search's documented 404 means no matching entities, not a guessed ID.
              if (error instanceof QlooError && error.code === "http" && error.status === 404) entities = [];
              else throw error;
            }
            signal.throwIfAborted();
            entities = entities.slice(0, 5);
            const chosen = this.request.resolutions?.[act];
            const exact = entities.filter(e => e.name.toLowerCase() === act.toLowerCase());
            const match = chosen ? entities.find(e => e.entity_id === chosen) : exact.length === 1 ? exact[0] : undefined;
            const resolution: Resolution = { name: act, status: match ? "matched" : entities.length ? "ambiguous" : "not_found", entities: match ? [match] : entities };
            this.resolutions.set(act, resolution);
            if (match) this.resolved.set(act, match);
            return resolution;
          }));
          result = { status: resolved.some(r => r.status === "ambiguous") ? "needs_input" : resolved.some(r => r.status === "matched") ? "ok" : "empty", results: resolved };
          break;
        }
        case "rank_against_audience": {
          const input = toolSchemas.rank_against_audience.parse(raw);
          params = input;
          if (input.city !== this.request.scenario.city || [...input.option_ids, ...input.signal_ids].some(id => !this.known(id))) throw new Error("Use only resolved scenario IDs and the scenario city");
          const options = [...new Set(input.option_ids)];
          const signals = [...new Set(input.signal_ids)];
          const cancelled = this.resolved.get(this.request.scenario.cancelled_act.name)?.entity_id;
          if (options.includes(cancelled ?? "") || options.some(id => signals.includes(id))) throw new Error("Options must exclude cancelled act and signal acts");
          const ranking: Ranking = { options, signals, results: [] };
          const entities = await abortable(this.qloo.rank(options, signals, input.city, signal), signal);
          signal.throwIfAborted();
          ranking.results = entities;
          this.rankings.push(ranking);
          result = { status: entities.length ? "ok" : "empty", results: entities };
          break;
        }
        case "local_heat": {
          const input = toolSchemas.local_heat.parse(raw);
          params = input;
          if (!this.known(input.entity_id) || input.region !== this.request.scenario.city) throw new Error("Use a resolved scenario ID and the scenario city");
          const heat = await abortable(this.qloo.heat(input.entity_id, input.region, signal), signal);
          signal.throwIfAborted();
          this.heats.set(input.entity_id, heat);
          result = { status: heat.length ? "ok" : "empty", results: heat };
          break;
        }
        default: throw new Error("Unknown tool");
      }
    } catch (error) {
      result = { status: "error", results: [], error: error instanceof QlooError ? error.message : "Invalid tool request or unavailable data; do not infer missing evidence." };
      if (signal.aborted) {
        this.trace.push({ tool: name.slice(0, 200), params: { ...this.redact(params), ...(by ? { by } : {}) }, status: "error", result_count: 0, ms: Math.round(performance.now() - start) });
        throw error;
      }
    }
    this.trace.push({ tool: name.slice(0, 200), params: { ...this.redact(params), ...(by ? { by } : {}) }, status: result.status, result_count: result.results.length, ms: Math.round(performance.now() - start) });
    return result;
  }
  ranking(id: string, signals: string[]): Entity | undefined {
    if (!signals.length) return;
    const key = [...signals].sort().join(",");
    return this.rankings.findLast(r => [...r.signals].sort().join(",") === key && r.options.includes(id))?.results.find(e => e.entity_id === id);
  }
  hasRanking(id: string, signals: string[]): boolean {
    const key = [...signals].sort().join(",");
    return this.rankings.some(r => r.options.includes(id) && [...r.signals].sort().join(",") === key);
  }
}
