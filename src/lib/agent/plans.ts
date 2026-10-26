import "server-only";
import { randomUUID } from "node:crypto";
import { z, ZodError } from "zod";
import { responseSchema, submissionSchema, type Plan, type RescueResponse, type Submission } from "../contracts";
import type { ToolContext } from "./tools";
import type { Heat } from "../qloo/types";

export const DISCLAIMERS = [
  "Qloo results describe what groups tend to like, not what one person will do.",
  "This tool does not predict availability, fees or ticket sales.",
  "Rebuild plans and announcements are drafts. Verify production, contracts and ticket terms before acting.",
];
export function llmMode(): "live" | "mock" {
  return !process.env.ANTHROPIC_API_KEY || process.env.LLM_MODE === "mock" ? "mock" : "live";
}
export function envelope(ctx: ToolContext, plans: Plan[], llm: RescueResponse["llm"] = llmMode(), fallbackReason?: string): RescueResponse {
  const s = ctx.request.scenario;
  const failed = ctx.lookupFailed;
  const lookupNotice = failed.length ? [`Qloo could not be reached for ${failed.length} ${failed.length === 1 ? "act" : "acts"} in this run (${failed.slice(0, 5).join(", ")}${failed.length > 5 ? ` and ${failed.length - 5} more` : ""}); they were not scored.`] : [];
  const fallbackNotice = fallbackReason === "qloo_limit" ? "Audience data was not fetched because of high request volume from this address. These plans use fixed rules only."
    : fallbackReason === "qloo_daily_budget" ? "Audience data was not fetched because this server reached its daily Qloo request budget. These plans use fixed rules only."
    : fallbackReason === "ip_limit" ? "Per-IP usage limit for the language model reached."
    : fallbackReason === "daily_cap" ? "Daily usage limit for the language model reached on this server."
    : fallbackReason === "deadline" ? "The language model time budget was reached."
    : "The language model did not complete an accepted plan.";
  return {
    run_id: randomUUID(), mode: ctx.request.mode, data_source: ctx.qloo.source, llm,
    excluded: ctx.filtered.excluded, needs_input: ctx.needsInput, not_in_catalog: ctx.notInCatalog, plans,
    announcement: {
      short_post: `${s.cancelled_act.name} cannot perform at ${s.festival_name} on ${s.date}. We are reviewing the running order. Confirmed changes and ticket guidance will follow through official channels.`,
      email_subject: `${s.festival_name}: programme update`,
      email_body: `Dear ticket holder,\n\n${s.cancelled_act.name} cannot perform on ${s.date} in ${s.city}. We are assessing replacement options and production requirements. No replacement is confirmed by this draft. Please check our official channels for the revised running order and ticket guidance under your ticket terms.\n\nThe festival team`,
    },
    refund_checklist: s.ticket_types.map(ticket_type => ({ ticket_type, items: [
      "Verify eligibility for a lineup change under this ticket type's published terms and applicable requirements.",
      "Decide and publish the request deadline and official refund channel after verification.",
      "Confirm treatment of booking fees, add-ons and partial attendance; do not promise an unapproved refund.",
      "Assign an organiser contact and verify replacement fees, payment timing and production requirements separately.",
    ] })),
    trace: [...ctx.trace],
    disclaimers: [...DISCLAIMERS, ...lookupNotice, ...(ctx.qloo.source === "mock" ? ["Sample data: fictional acts and synthetic pseudo-affinity; these are not live Qloo results."] : []), ...(ctx.request.mode === "baseline" ? ["Ungrounded suggestions; no Qloo catalog lookup or audience scoring was performed."] : []), ...(llm === "fallback" ? [
      `${fallbackNotice} These plans were assembled by fixed rules from ${ctx.request.mode === "baseline" ? "the same scenario and hard constraints; no Qloo evidence was used" : "the same Qloo evidence"}.`,
    ] : [])],
  };
}
function metric(value: number | null | undefined, sample: boolean) {
  return value == null ? "No affinity data available" : `${sample ? "Synthetic pseudo-affinity" : "Qloo affinity"} ${value.toFixed(3)} (not a probability)`;
}
function heatEvidence(heat: Heat[], city: string, sample: boolean) {
  if (!heat.length) return "No local heat evidence available.";
  const named = heat.filter(h => h.label.trim() && h.label !== "Unnamed area" && !/^[0-9b-hjkmnp-z]{4,12}$/.test(h.label.trim()));
  const places = named.map(h => `${h.label}: ${metric(h.affinity, sample)}`).join("; ");
  if (named.length === heat.length) return places;
  const affinities = heat.flatMap(h => h.affinity === null ? [] : [h.affinity]);
  const top = affinities.length ? `top ${Math.max(...affinities).toFixed(3)}, not a probability` : "no affinity data available";
  return `${heat.length} ${heat.length === 1 ? "area" : "areas"} in ${city} with ${sample ? "synthetic local affinity" : "local affinity"} (${top})${places ? `; ${places}` : ""}`;
}
export class SubmissionError extends Error {
  constructor(message: string, readonly plan_id: string | null = null) {
    super(message);
    this.name = "SubmissionError";
  }
}

// Keep the submission contract and its limits; validate each plan separately so
// an invalid sibling cannot discard a usable plan.
const submissionEnvelopeSchema = submissionSchema.extend({ plans: z.array(z.unknown()).max(3) });
function validationError(error: ZodError, prefix: (string | number)[] = [], plan_id: string | null = null) {
  const issue = error.issues[0];
  const path = [...prefix, ...issue.path].join(".") || "submission";
  // Unrecognised keys can contain arbitrary model/user text. Never echo them.
  const reason = issue.code === "unrecognized_keys" ? "Unexpected fields are not allowed" : issue.message;
  return new SubmissionError(`${path}: ${reason}`, plan_id);
}
function recordRejection(ctx: ToolContext, error: SubmissionError) {
  ctx.trace.push({ tool: "submit_rescue_plan", status: "error", params: { reason: error.message, plan_id: error.plan_id }, result_count: 0, ms: 0 });
}
function parseSubmission(ctx: ToolContext, raw: unknown) {
  try { return submissionEnvelopeSchema.parse(raw); }
  catch (error) {
    if (!(error instanceof ZodError)) throw error;
    const rejection = validationError(error);
    recordRejection(ctx, rejection);
    throw rejection;
  }
}

/** Validate decisions first, complete missing observations, then compose the public response. */
export async function finalise(ctx: ToolContext, raw: unknown, { llm = llmMode(), signal = ctx.signal, fallbackReason }: { llm?: RescueResponse["llm"]; signal?: AbortSignal; fallbackReason?: string } = {}): Promise<RescueResponse> {
  signal.throwIfAborted();
  const submitted = parseSubmission(ctx, raw);
  const valid: Submission["plans"] = [];
  const rejected: SubmissionError[] = [];
  const seen = new Set<string>();
  for (const [index, input] of submitted.plans.entries()) {
    const parsed = submissionSchema.shape.plans.element.safeParse(input);
    if (!parsed.success) {
      const id = input && typeof input === "object" && "id" in input && typeof input.id === "string" ? input.id.slice(0, 200) : null;
      const error = validationError(parsed.error, ["plans", index], id);
      recordRejection(ctx, error);
      rejected.push(error);
      continue;
    }
    const plan = parsed.data;
    const fail = (reason: string): never => { throw new SubmissionError(reason, plan.id); };
    try {
      if (seen.has(plan.id)) fail("Plan IDs must be unique");
      if (!ctx.filtered.eligible.some(a => a.name === plan.replacement)) fail("Ineligible replacement");
      if (plan.type === "direct_swap" && plan.promoted_act !== null) fail("Invalid promotion path: a direct swap requires promoted_act null");
      if (plan.type === "promote_and_fill" && !ctx.request.scenario.lineup.some(a => a.name === plan.promoted_act)) fail("Invalid promotion path: promoted_act is not an existing lineup act");
      if (ctx.request.mode === "qloo") {
        for (const [field, name] of [["cancelled_act", ctx.request.scenario.cancelled_act.name], ["replacement", plan.replacement], ...(plan.promoted_act ? [["promoted_act", plan.promoted_act]] : [])]) {
          if (!ctx.resolved.has(name)) fail(`Unresolved or unknown act: ${field}`);
        }
      }
      seen.add(plan.id);
      valid.push(plan);
    } catch (error) {
      if (!(error instanceof SubmissionError)) throw error;
      recordRejection(ctx, error);
      rejected.push(error);
    }
  }
  if (submitted.plans.length && !valid.length) throw rejected[0];

  const defaults = envelope(ctx, []).refund_checklist;
  const checklists = new Map<string, string[]>();
  for (const entry of submitted.refund_checklist) {
    const key = entry.ticket_type.trim().toLowerCase();
    if (defaults.some(t => t.ticket_type.toLowerCase() === key) && !checklists.has(key)) checklists.set(key, entry.items);
  }
  const refund_checklist = defaults.map(entry => ({ ...entry, items: checklists.get(entry.ticket_type.toLowerCase()) ?? entry.items }));
  // Compare to the raw checklist too: the schema already trims ticket strings.
  if (JSON.stringify(refund_checklist) !== JSON.stringify((raw as Submission).refund_checklist)) {
    ctx.trace.push({ tool: "submit_rescue_plan", status: "ok", params: { reason: "Refund checklist normalised: exact supplied ticket types, first match kept, server defaults for omissions", plan_id: null }, result_count: refund_checklist.length, ms: 0 });
  }

  const prepared = valid.map(plan => {
    const original = ctx.resolved.get(ctx.request.scenario.cancelled_act.name)?.entity_id;
    const replacement = ctx.resolved.get(plan.replacement)?.entity_id;
    const promoted = plan.promoted_act ? ctx.resolved.get(plan.promoted_act)?.entity_id : undefined;
    const headliner = promoted ?? replacement;
    const lineupIds = [...new Set(ctx.request.scenario.lineup.flatMap(a => {
      const id = ctx.resolved.get(a.name)?.entity_id;
      return id && id !== headliner ? [id] : [];
    }))];
    return { plan, original, replacement, promoted, headliner, lineupIds };
  });
  if (ctx.request.mode === "qloo") {
    // Group identical signal sets, deduplicate finalists, and fetch independent
    // observations in parallel. An empty/error result stays unknown, never zero.
    const rankings = new Map<string, { options: Set<string>; signals: string[] }>();
    const heats = new Set<string>();
    const needRank = (id: string, signals: string[]) => {
      if (!signals.length || ctx.hasRanking(id, signals)) return;
      const key = [...signals].sort().join(",");
      const batch = rankings.get(key) ?? { options: new Set<string>(), signals };
      batch.options.add(id);
      rankings.set(key, batch);
    };
    for (const { original, replacement, promoted, headliner, lineupIds } of prepared) {
      needRank(headliner!, [original!]);
      needRank(replacement!, lineupIds);
      if (promoted) needRank(replacement!, [promoted]);
      for (const id of [headliner!, replacement!]) if (!ctx.heats.has(id)) heats.add(id);
    }
    await Promise.all([
      ...[...rankings.values()].map(batch => ctx.execute("rank_against_audience", { option_ids: [...batch.options], signal_ids: batch.signals, city: ctx.request.scenario.city }, "server", signal)),
      ...[...heats].map(id => ctx.execute("local_heat", { entity_id: id, region: ctx.request.scenario.city }, "server", signal)),
    ]);
  }
  const plans: Plan[] = prepared.map(({ plan, original, replacement, promoted, headliner, lineupIds }) => {
    if (ctx.request.mode === "baseline") return { ...plan, evidence: {
      fit_original_audience: llm === "fallback" ? "Fixed-rule suggestion; no audience data." : "LLM-only guess; no audience data.", fit_lineup_audience: llm === "fallback" ? "Fixed-rule suggestion; no audience data." : "LLM-only guess; no audience data.", local_heat: "Not checked; no Qloo tools.",
    }, caveats: [...plan.caveats, "Ungrounded suggestion; verify fit with the organiser."] };
    const originalFit = ctx.ranking(headliner!, [original!]);
    const fillFit = promoted ? ctx.ranking(replacement!, [promoted]) : undefined;
    const heat = ctx.heats.get(headliner!) ?? [];
    const sample = ctx.qloo.source === "mock";
    return { ...plan, evidence: {
      fit_original_audience: `${plan.promoted_act ?? plan.replacement}: ${metric(originalFit?.affinity, sample)}${promoted ? `; ${plan.replacement} filling ${plan.promoted_act}'s slot: ${metric(fillFit?.affinity, sample)}` : ""}`,
      fit_lineup_audience: `${plan.replacement}: ${metric(ctx.ranking(replacement!, lineupIds)?.affinity, sample)}${ctx.request.scenario.lineup.length !== lineupIds.length + (promoted ? 1 : 0) ? "; only resolved lineup acts included" : ""}`,
      local_heat: heatEvidence(heat, ctx.request.scenario.city, sample),
    }, caveats: [...plan.caveats, "Affinity is aggregate evidence, not a guarantee of audience response."] };
  });
  signal.throwIfAborted();
  ctx.trace.push({ tool: "submit_rescue_plan", params: { plan_count: plans.length }, status: plans.length ? "ok" : "empty", result_count: plans.length, ms: 0 });
  const response = envelope(ctx, plans, llm, fallbackReason);
  response.disclaimers.push(...rejected.map(error => `One suggested plan was dropped: ${error.message}`));
  return responseSchema.parse({ ...response, announcement: submitted.announcement, refund_checklist });
}
