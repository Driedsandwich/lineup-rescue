import "server-only";
import { randomUUID } from "node:crypto";
import { responseSchema, type Plan, type RescueResponse } from "../contracts";
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
/** Replace model evidence with observed results and constrain plans to the phone list. */
export function finalise(ctx: ToolContext, raw: unknown): RescueResponse {
  const submitted = responseSchema.parse(raw);
  const seen = new Set<string>();
  const plans = submitted.plans.map(plan => {
    if (seen.has(plan.id)) throw new Error("Plan IDs must be unique");
    seen.add(plan.id);
    if (!ctx.filtered.eligible.some(a => a.name === plan.replacement)) throw new Error("Plan contains an ineligible replacement");
    if (plan.type === "direct_swap" ? plan.promoted_act !== null : !ctx.request.scenario.lineup.some(a => a.name === plan.promoted_act)) throw new Error("Invalid promotion path");
    if (ctx.request.mode === "baseline") return { ...plan, evidence: {
      fit_original_audience: "LLM-only guess; no audience data.", fit_lineup_audience: "LLM-only guess; no audience data.", local_heat: "Not checked; no Qloo tools.",
    }, caveats: [...plan.caveats, "Ungrounded suggestion; verify fit with the organiser."].slice(0, 12) };
    const original = ctx.resolved.get(ctx.request.scenario.cancelled_act.name)?.entity_id;
    const replacement = ctx.resolved.get(plan.replacement)?.entity_id;
    const promoted = plan.promoted_act ? ctx.resolved.get(plan.promoted_act)?.entity_id : undefined;
    if (!original || !replacement || (plan.promoted_act && !promoted)) throw new Error("Unresolved or unknown acts cannot be planned or scored");
    const headliner = promoted ?? replacement;
    const originalFit = ctx.ranking(headliner, [original]);
    if (!originalFit) throw new Error("A Qloo-grounded plan requires observed original-audience ranking");
    const lineupIds = ctx.request.scenario.lineup.flatMap(a => {
      const id = ctx.resolved.get(a.name)?.entity_id;
      return id && id !== headliner ? [id] : [];
    });
    const fillFit = promoted ? ctx.ranking(replacement, [promoted]) : undefined;
    if (promoted && !fillFit) throw new Error("Promotion requires evidence for filling the freed slot");
    if (lineupIds.length && !ctx.rankings.some(r => r.options.includes(replacement) && [...r.signals].sort().join(",") === [...lineupIds].sort().join(","))) throw new Error("Check replacement against the remaining lineup audience before submitting");
    if (!ctx.heats.has(headliner) || !ctx.heats.has(replacement)) throw new Error("Check local heat for each finalist before submitting");
    const heat = ctx.heats.get(headliner) ?? [];
    const sample = ctx.qloo.source === "mock";
    return { ...plan, evidence: {
      fit_original_audience: `${plan.promoted_act ?? plan.replacement}: ${metric(originalFit.affinity, sample)}${promoted ? `; ${plan.replacement} filling ${plan.promoted_act}'s slot: ${metric(fillFit?.affinity, sample)}` : ""}`,
      fit_lineup_audience: `${plan.replacement}: ${metric(ctx.ranking(replacement, lineupIds)?.affinity, sample)}${ctx.request.scenario.lineup.length !== lineupIds.length + (promoted ? 1 : 0) ? "; only resolved lineup acts included" : ""}`,
      local_heat: heat.length ? heat.map(h => `${h.label}: ${metric(h.affinity, sample)}`).join("; ") : "No local heat evidence available.",
    }, caveats: [...plan.caveats, "Affinity is aggregate evidence, not a guarantee of audience response."].slice(0, 12) };
  });
  if (ctx.request.mode === "qloo" && [...ctx.names].some(n => !ctx.resolutions.has(n))) throw new Error("Resolve every eligible scenario act before submitting");
  const ticketTypes = submitted.refund_checklist.map(t => t.ticket_type);
  if (ticketTypes.length !== ctx.request.scenario.ticket_types.length || new Set(ticketTypes).size !== ticketTypes.length || ticketTypes.some(t => !ctx.request.scenario.ticket_types.includes(t))) throw new Error("Refund checklist must cover every supplied ticket type exactly once");
  ctx.trace.push({ tool: "submit_rescue_plan", params: { plan_count: plans.length }, status: plans.length ? "ok" : "empty", result_count: plans.length, ms: 0 });
  const base = envelope(ctx, plans);
  return responseSchema.parse({ ...base, announcement: submitted.announcement, refund_checklist: submitted.refund_checklist });
}
