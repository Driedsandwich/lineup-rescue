import "server-only";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { responseSchema, submissionSchema, type Plan, type RescueResponse } from "../contracts";
import type { ToolContext } from "./tools";

export const DISCLAIMERS = [
  "Qloo results describe what groups tend to like, not what one person will do.",
  "This tool does not predict availability, fees or ticket sales.",
  "Rebuild plans and announcements are drafts. Verify production, contracts and ticket terms before acting.",
];
export function llmMode(): "live" | "mock" {
  return !process.env.ANTHROPIC_API_KEY || process.env.LLM_MODE === "mock" ? "mock" : "live";
}
export function envelope(ctx: ToolContext, plans: Plan[]): RescueResponse {
  const s = ctx.request.scenario;
  return {
    run_id: randomUUID(), mode: ctx.request.mode, data_source: ctx.qloo.source, llm: llmMode(),
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
    disclaimers: [...DISCLAIMERS, ...(ctx.qloo.source === "mock" ? ["Sample data: fictional acts and synthetic pseudo-affinity; these are not live Qloo results."] : []), ...(ctx.request.mode === "baseline" ? ["LLM only: ungrounded suggestions; no Qloo catalog lookup or audience scoring was performed."] : [])],
  };
}
function metric(value: number | null | undefined, sample: boolean) {
  return value == null ? "No affinity data available" : `${sample ? "Synthetic pseudo-affinity" : "Qloo affinity"} ${value.toFixed(3)} (not a probability)`;
}
export class SubmissionError extends Error {
  constructor(message: string, readonly plan_id: string | null = null) {
    super(message);
    this.name = "SubmissionError";
  }
}

function parseSubmission(raw: unknown) {
  try { return submissionSchema.parse(raw); }
  catch (error) {
    if (!(error instanceof ZodError)) throw error;
    const issue = error.issues[0];
    const index = issue.path[0] === "plans" && typeof issue.path[1] === "number" ? issue.path[1] : undefined;
    const plans = raw && typeof raw === "object" && "plans" in raw ? raw.plans : undefined;
    const plan = Array.isArray(plans) && index !== undefined ? plans[index] : undefined;
    throw new SubmissionError(`${issue.path.join(".") || "submission"}: ${issue.message}`, typeof plan?.id === "string" ? plan.id : null);
  }
}

/** Validate decisions first, complete missing observations, then compose the public response. */
export async function finalise(ctx: ToolContext, raw: unknown): Promise<RescueResponse> {
  const submitted = parseSubmission(raw);
  const seen = new Set<string>();
  for (const plan of submitted.plans) {
    const fail = (reason: string): never => { throw new SubmissionError(reason, plan.id); };
    if (seen.has(plan.id)) fail("Plan IDs must be unique");
    seen.add(plan.id);
    if (!ctx.filtered.eligible.some(a => a.name === plan.replacement)) fail(`Ineligible replacement: ${plan.replacement}`);
    if (plan.type === "direct_swap" && plan.promoted_act !== null) fail("Invalid promotion path: a direct swap requires promoted_act null");
    if (plan.type === "promote_and_fill" && !ctx.request.scenario.lineup.some(a => a.name === plan.promoted_act)) fail(`Invalid promotion path: ${plan.promoted_act ?? "null"} is not an existing lineup act`);
    if (ctx.request.mode === "qloo") {
      for (const name of [ctx.request.scenario.cancelled_act.name, plan.replacement, ...(plan.promoted_act ? [plan.promoted_act] : [])]) {
        if (!ctx.resolved.has(name)) fail(`Unresolved or unknown act: ${name}`);
      }
    }
  }
  const ticketTypes = submitted.refund_checklist.map(t => t.ticket_type);
  if (ticketTypes.length !== ctx.request.scenario.ticket_types.length || new Set(ticketTypes).size !== ticketTypes.length || ticketTypes.some(t => !ctx.request.scenario.ticket_types.includes(t))) {
    const missing = ctx.request.scenario.ticket_types.filter(t => !ticketTypes.includes(t));
    const duplicates = [...new Set(ticketTypes.filter((t, i) => ticketTypes.indexOf(t) !== i))];
    const unknown = ticketTypes.filter(t => !ctx.request.scenario.ticket_types.includes(t));
    throw new SubmissionError(`Refund checklist must cover every supplied ticket type exactly once: ${JSON.stringify({ missing, duplicates, unknown })}`);
  }

  const prepared = submitted.plans.map(plan => {
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
      ...[...rankings.values()].map(batch => ctx.execute("rank_against_audience", { option_ids: [...batch.options], signal_ids: batch.signals, city: ctx.request.scenario.city }, "server")),
      ...[...heats].map(id => ctx.execute("local_heat", { entity_id: id, region: ctx.request.scenario.city }, "server")),
    ]);
  }
  const plans: Plan[] = prepared.map(({ plan, original, replacement, promoted, headliner, lineupIds }) => {
    if (ctx.request.mode === "baseline") return { ...plan, evidence: {
      fit_original_audience: "LLM-only guess; no audience data.", fit_lineup_audience: "LLM-only guess; no audience data.", local_heat: "Not checked; no Qloo tools.",
    }, caveats: [...plan.caveats, "Ungrounded suggestion; verify fit with the organiser."] };
    const originalFit = ctx.ranking(headliner!, [original!]);
    const fillFit = promoted ? ctx.ranking(replacement!, [promoted]) : undefined;
    const heat = ctx.heats.get(headliner!) ?? [];
    const sample = ctx.qloo.source === "mock";
    return { ...plan, evidence: {
      fit_original_audience: `${plan.promoted_act ?? plan.replacement}: ${metric(originalFit?.affinity, sample)}${promoted ? `; ${plan.replacement} filling ${plan.promoted_act}'s slot: ${metric(fillFit?.affinity, sample)}` : ""}`,
      fit_lineup_audience: `${plan.replacement}: ${metric(ctx.ranking(replacement!, lineupIds)?.affinity, sample)}${ctx.request.scenario.lineup.length !== lineupIds.length + (promoted ? 1 : 0) ? "; only resolved lineup acts included" : ""}`,
      local_heat: heat.length ? heat.map(h => `${h.label}: ${metric(h.affinity, sample)}`).join("; ") : "No local heat evidence available.",
    }, caveats: [...plan.caveats, "Affinity is aggregate evidence, not a guarantee of audience response."] };
  });
  ctx.trace.push({ tool: "submit_rescue_plan", params: { plan_count: plans.length }, status: plans.length ? "ok" : "empty", result_count: plans.length, ms: 0 });
  return responseSchema.parse({ ...envelope(ctx, plans), announcement: submitted.announcement, refund_checklist: submitted.refund_checklist });
}
