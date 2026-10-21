import "server-only";
import type { Submission } from "../contracts";
import { envelope } from "./plans";
import type { ToolContext } from "./tools";
import type { Entity } from "../qloo/types";

export async function mockPlan(ctx: ToolContext): Promise<Submission> {
  const s = ctx.request.scenario;
  const plans: Submission["plans"] = [];
  const finish = (): Submission => {
    const { announcement, refund_checklist } = envelope(ctx, []);
    return { plans, announcement: {
      short_post: announcement.short_post.slice(0, 280),
      email_subject: announcement.email_subject.slice(0, 120),
      email_body: announcement.email_body.slice(0, 1200),
    }, refund_checklist };
  };
  if (ctx.request.mode === "baseline") {
    // Deliberately retains the input order: an explicitly ungrounded control.
    for (const candidate of ctx.filtered.eligible.slice(0, 2)) plans.push({
      id: String.fromCharCode(65 + plans.length), title: `Consider ${candidate.name}`, type: "direct_swap", replacement: candidate.name, promoted_act: null,
      rationale: "Fixed-rule suggestion using phone-list order, without taste evidence.", caveats: ["No catalog lookup was performed."],
    });
    if (ctx.filtered.eligible[0] && s.lineup[0]) plans.push({
      id: "C", title: `Consider promoting ${s.lineup[0].name}`, type: "promote_and_fill", replacement: ctx.filtered.eligible[0].name, promoted_act: s.lineup[0].name,
      rationale: `Move ${s.lineup[0].name} to ${s.cancelled_act.slot}; ${ctx.filtered.eligible[0].name} fills ${s.lineup[0].stage} ${s.lineup[0].slot}. This is an ungrounded option.`.slice(0, 600), caveats: ["Confirm revised set length, timing and production."],
    });
    return finish();
  }
  // resolve_acts is executed once as a shared preflight for mock and live agents.
  const options = ctx.filtered.eligible.flatMap(a => ctx.resolved.get(a.name) ?? []);
  const original = ctx.resolved.get(s.cancelled_act.name);
  const lineup = s.lineup.flatMap(a => ctx.resolved.get(a.name) ?? []);
  const nameFor = (id: string) => [...ctx.resolved].find(([, entity]) => entity.entity_id === id)![0];
  if (!original || !options.length) return finish();
  // Read observations by exact signal set, never by their arrival order. A live
  // model may already have populated some or all of these, including empty data.
  const rank = async (acts: Entity[], signals: Entity[]) => {
    if (!acts.length || !signals.length) return [];
    const signalIds = signals.map(e => e.entity_id);
    const missing = acts.filter(e => !ctx.hasRanking(e.entity_id, signalIds));
    if (missing.length) await ctx.execute("rank_against_audience", { option_ids: missing.map(e => e.entity_id), signal_ids: signalIds, city: s.city });
    return acts.flatMap(e => ctx.ranking(e.entity_id, signalIds) ?? []).sort((a, b) => (b.affinity ?? -1) - (a.affinity ?? -1));
  };
  const [ranked, , promotions] = await Promise.all([rank(options, [original]), rank(options, lineup), rank(lineup, [original])]);
  for (const candidate of ranked.slice(0, 2)) {
    const candidateName = nameFor(candidate.entity_id);
    plans.push({ id: String.fromCharCode(65 + plans.length), title: `Direct swap: ${candidateName}`, type: "direct_swap", replacement: candidateName, promoted_act: null,
      rationale: `Compare ${candidateName} with both audiences; retain the rest of the running order. Proposed slot: ${s.cancelled_act.slot}.`, caveats: ["Confirm fee, rider, set length and changeover with the booker."] });
  }
  const promoted = promotions[0];
  if (promoted) {
    const fill = (await rank(options, [promoted]))[0];
    if (fill) {
      const promotedName = nameFor(promoted.entity_id);
      const fillName = nameFor(fill.entity_id);
      const slot = s.lineup.find(a => a.name === promotedName)!;
      plans.push({ id: "C", title: `Promote ${promotedName}; fill with ${fillName}`, type: "promote_and_fill", replacement: fillName, promoted_act: promotedName,
        rationale: `Move ${promotedName} to ${s.cancelled_act.slot}. ${fillName} takes the freed ${slot.stage} ${slot.slot} slot.`.slice(0, 600), caveats: ["Check expanded headline set and both production changeovers."] });
    }
  }
  const finalists = new Set(plans.flatMap(p => [ctx.resolved.get(p.replacement)!.entity_id, ...(p.promoted_act ? [ctx.resolved.get(p.promoted_act)!.entity_id] : [])]));
  await Promise.all([...finalists].filter(id => !ctx.heats.has(id)).map(id => ctx.execute("local_heat", { entity_id: id, region: s.city })));
  return finish();
}
