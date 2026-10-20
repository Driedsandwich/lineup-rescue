import "server-only";
import type { Plan } from "../contracts";
import { envelope } from "./plans";
import type { ToolContext } from "./tools";

const blank = { fit_original_audience: "Not checked", fit_lineup_audience: "Not checked", local_heat: "Not checked" };
export async function mockPlan(ctx: ToolContext) {
  const s = ctx.request.scenario;
  const plans: Plan[] = [];
  if (ctx.request.mode === "baseline") {
    // Deliberately retains the input order: an explicitly ungrounded control.
    for (const candidate of ctx.filtered.eligible.slice(0, 2)) plans.push({
      id: String.fromCharCode(65 + plans.length), title: `Consider ${candidate.name}`, type: "direct_swap", replacement: candidate.name, promoted_act: null,
      evidence: blank, rationale: "Deterministic LLM-only sample guess using phone-list order, without taste evidence.", caveats: ["No catalog lookup was performed."],
    });
    if (ctx.filtered.eligible[0] && s.lineup[0]) plans.push({
      id: "C", title: `Consider promoting ${s.lineup[0].name}`, type: "promote_and_fill", replacement: ctx.filtered.eligible[0].name, promoted_act: s.lineup[0].name,
      evidence: blank, rationale: `Move ${s.lineup[0].name} to ${s.cancelled_act.slot}; ${ctx.filtered.eligible[0].name} fills ${s.lineup[0].stage} ${s.lineup[0].slot}. This is an ungrounded sample option.`, caveats: ["Confirm revised set length, timing and production."],
    });
    return envelope(ctx, plans);
  }
  // resolve_acts is executed once as a shared preflight for mock and live agents.
  const options = ctx.filtered.eligible.flatMap(a => ctx.resolved.get(a.name) ?? []);
  const original = ctx.resolved.get(s.cancelled_act.name);
  const lineup = s.lineup.flatMap(a => ctx.resolved.get(a.name) ?? []);
  const nameFor = (id: string) => [...ctx.resolved].find(([, entity]) => entity.entity_id === id)![0];
  if (!original || !options.length) return envelope(ctx, []);
  await ctx.execute("rank_against_audience", { option_ids: options.map(e => e.entity_id), signal_ids: [original.entity_id], city: s.city });
  if (lineup.length) await ctx.execute("rank_against_audience", { option_ids: options.map(e => e.entity_id), signal_ids: lineup.map(e => e.entity_id), city: s.city });
  const ranked = ctx.rankings[0]?.results ?? [];
  for (const candidate of ranked.slice(0, 2)) {
    const candidateName = nameFor(candidate.entity_id);
    await ctx.execute("local_heat", { entity_id: candidate.entity_id, region: s.city });
    plans.push({ id: String.fromCharCode(65 + plans.length), title: `Direct swap: ${candidateName}`, type: "direct_swap", replacement: candidateName, promoted_act: null,
      evidence: blank, rationale: `Compare ${candidateName} with both audiences; retain the rest of the running order. Proposed slot: ${s.cancelled_act.slot}.`, caveats: ["Confirm fee, rider, set length and changeover with the booker."] });
  }
  if (lineup.length) {
    await ctx.execute("rank_against_audience", { option_ids: lineup.map(e => e.entity_id), signal_ids: [original.entity_id], city: s.city });
    const promoted = ctx.rankings.at(-1)?.results[0];
    if (promoted) {
      await ctx.execute("rank_against_audience", { option_ids: options.map(e => e.entity_id), signal_ids: [promoted.entity_id], city: s.city });
      const fill = ctx.rankings.at(-1)?.results[0];
      const remaining = lineup.filter(e => e.entity_id !== promoted.entity_id);
      if (remaining.length) await ctx.execute("rank_against_audience", { option_ids: options.map(e => e.entity_id), signal_ids: remaining.map(e => e.entity_id), city: s.city });
      await ctx.execute("local_heat", { entity_id: promoted.entity_id, region: s.city });
      if (fill) {
        if (!ctx.heats.has(fill.entity_id)) await ctx.execute("local_heat", { entity_id: fill.entity_id, region: s.city });
        const promotedName = nameFor(promoted.entity_id);
        const fillName = nameFor(fill.entity_id);
        const slot = s.lineup.find(a => a.name === promotedName)!;
        plans.push({ id: "C", title: `Promote ${promotedName}; fill with ${fillName}`, type: "promote_and_fill", replacement: fillName, promoted_act: promotedName,
          evidence: blank, rationale: `Move ${promotedName} to ${s.cancelled_act.slot}. ${fillName} takes the freed ${slot.stage} ${slot.slot} slot.`, caveats: ["Check expanded headline set and both production changeovers."] });
      }
    }
  }
  return envelope(ctx, plans);
}
