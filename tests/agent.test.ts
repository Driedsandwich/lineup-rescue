import { describe, expect, it, vi } from "vitest";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import sample from "../samples/scenario.json";
import { requestSchema, responseSchema, type RescueRequest, type Submission } from "../src/lib/contracts";
import { filterCandidates } from "../src/lib/agent/constraints";
import { ToolContext, definitions } from "../src/lib/agent/tools";
import { finalise } from "../src/lib/agent/plans";
import { mockPlan } from "../src/lib/agent/mock";
import { liveLoop, runAgent, type MessageSender } from "../src/lib/agent/loop";
import { MockQloo } from "../src/lib/qloo/mock";

function context(mode: "qloo" | "baseline" = "qloo", changes: Partial<RescueRequest> = {}) {
  return new ToolContext(requestSchema.parse({ mode, scenario: sample, ...changes }), new MockQloo(), new AbortController().signal);
}
async function resolved() { const ctx = context(); await ctx.execute("resolve_acts", { names: [...ctx.names] }); return ctx; }
const message = (stop_reason: Message["stop_reason"], content: unknown[] = []) => ({ id: "synthetic-message", type: "message", role: "assistant", model: "claude-haiku-5-5", stop_reason, content, stop_sequence: null, usage: {} }) as unknown as Message;

const direct: Submission["plans"][number] = {
  id: "A", title: "Direct swap", type: "direct_swap", replacement: sample.candidates[0].name,
  promoted_act: null, rationale: "Check the replacement with the organiser.", caveats: ["Confirm fees and timing."],
};
const promotion: Submission["plans"][number] = {
  ...direct, id: "B", title: "Promote and fill", type: "promote_and_fill", promoted_act: sample.lineup[0].name,
};
function submission(plans: Submission["plans"] = [{ ...direct }]): Submission {
  return { plans, announcement: { short_post: "Programme under review.", email_subject: "Programme update", email_body: "Check official channels for confirmed changes." },
    refund_checklist: sample.ticket_types.map(ticket_type => ({ ticket_type, items: ["Verify the published terms."] })) };
}

describe("hard constraints and grounded plan assembly", () => {
  it("excludes unavailable/late acts before agent tools and accepts absent travel time", () => {
    const result = filterCandidates([...sample.candidates, { name: "Sample contradiction", available: true, can_arrive_48h: true, travel_hours: 49, notes: "" }]);
    expect(result.excluded.map(a => a.name)).toEqual(["Sample Glass Meadow", "Sample Silver Kite", "Sample contradiction"]);
    expect(result.eligible.some(a => a.name === "Sample Distant Arcade")).toBe(true);
  });
  it("preserves ambiguous/unknown states; validates resolution against fresh search options", async () => {
    const ctx = context("qloo", { scenario: { ...sample, candidates: [...sample.candidates, { name: "Sample Never Catalogued", available: true, can_arrive_48h: true, notes: "" }] }, resolutions: { "Sample Twin Lantern": "invented-id" } });
    await ctx.execute("resolve_acts", { names: [...ctx.names] });
    expect(ctx.needsInput[0].name).toBe("Sample Twin Lantern");
    expect(ctx.notInCatalog).toEqual(["Sample Never Catalogued"]);
    expect(ctx.resolved.has("Sample Twin Lantern")).toBe(false);
    const chosen = context("qloo", { resolutions: { "Sample Twin Lantern": "mock-artist-010" } });
    await chosen.execute("resolve_acts", { names: [...chosen.names] });
    expect(chosen.resolved.get("Sample Twin Lantern")?.entity_id).toBe("mock-artist-010");
    expect(chosen.needsInput).toEqual([]);
  });
  it("produces 2 direct plans and a promotion with observed evidence, refunds and trace", async () => {
    const result = await runAgent(requestSchema.parse({ mode: "qloo", scenario: sample }), new AbortController().signal);
    expect(responseSchema.safeParse(result).success).toBe(true);
    expect(result.plans).toHaveLength(3);
    expect(result.plans[2].type).toBe("promote_and_fill");
    expect(result.plans[0].evidence.fit_original_audience).toContain("Synthetic pseudo-affinity");
    expect(result.plans[2].evidence.fit_original_audience).toContain("filling");
    expect(result.refund_checklist.map(t => t.ticket_type)).toEqual(sample.ticket_types);
    expect(result.refund_checklist[0].items.join(" ")).toContain("Verify eligibility");
    expect(result.trace.at(-1)?.tool).toBe("submit_rescue_plan");
    expect(result.trace.filter(t => t.tool === "rank_against_audience").length).toBeGreaterThanOrEqual(4);
    const ctx = await resolved();
    const draft = await mockPlan(ctx);
    for (const plan of draft.plans) {
      expect(ctx.heats.has(ctx.resolved.get(plan.replacement)!.entity_id)).toBe(true);
      if (plan.promoted_act) expect(ctx.heats.has(ctx.resolved.get(plan.promoted_act)!.entity_id)).toBe(true);
    }
    expect(JSON.stringify(result.trace)).not.toContain("production rider");
    expect(JSON.stringify(result.trace)).not.toContain("mock-artist-001");
  });
  it("baseline never calls Qloo and labels every evidence field as ungrounded", async () => {
    const ctx = context("baseline");
    const search = vi.spyOn(ctx.qloo, "search");
    const result = await finalise(ctx, await mockPlan(ctx));
    expect(search).not.toHaveBeenCalled();
    expect(result.trace.map(t => t.tool)).toEqual(["submit_rescue_plan"]);
    expect(result.plans.every(p => p.evidence.fit_original_audience.includes("guess"))).toBe(true);
    expect(result.needs_input).toEqual([]);
  });
  it("keeps scenario names when ranking results return different catalog labels", async () => {
    const ctx = await resolved();
    const mock = new MockQloo();
    vi.spyOn(ctx.qloo, "rank").mockImplementation(async (options, signals, city) => (await mock.rank(options, signals, city)).map(entity => ({ ...entity, name: `${entity.name} (catalog label)` })));
    const result = await finalise(ctx, await mockPlan(ctx));
    expect(result.plans).toHaveLength(3);
    expect(result.plans.every(p => sample.candidates.some(a => a.name === p.replacement))).toBe(true);
    expect(sample.lineup.some(a => a.name === result.plans[2].promoted_act)).toBe(true);
  });
  it("rejects excluded replacements and composes observed evidence", async () => {
    const ctx = await resolved();
    const draft = await mockPlan(ctx);
    draft.plans[0].replacement = "Sample Glass Meadow";
    await expect(finalise(ctx, draft)).rejects.toMatchObject({ message: "Ineligible replacement: Sample Glass Meadow", plan_id: draft.plans[0].id });
    const fresh = await mockPlan(ctx);
    expect(fresh.plans[0]).not.toHaveProperty("evidence");
    expect((await finalise(ctx, fresh)).plans[0].evidence.fit_original_audience).toContain("Synthetic pseudo-affinity");
  });
  it("does not score missing catalog acts or fabricate plans with no eligible options", async () => {
    const ctx = context("qloo", { scenario: { ...sample, cancelled_act: { ...sample.cancelled_act, name: "Sample Unknown Headliner" }, candidates: [] } });
    await ctx.execute("resolve_acts", { names: [...ctx.names] });
    const result = await finalise(ctx, await mockPlan(ctx));
    expect(result.plans).toEqual([]);
    expect(result.not_in_catalog).toContain("Sample Unknown Headliner");
  });
  it("allows only scenario names, resolved IDs and the scenario city; never sends notes", async () => {
    const ctx = await resolved();
    const rank = vi.spyOn(ctx.qloo, "rank");
    expect((await ctx.execute("rank_against_audience", { option_ids: ["invented-id"], signal_ids: ["mock-artist-001"], city: sample.city })).status).toBe("error");
    expect((await ctx.execute("resolve_acts", { names: ["Sample Glass Meadow"] })).status).toBe("error");
    expect((await ctx.execute("local_heat", { entity_id: "mock-artist-001", region: "Wrong city" })).status).toBe("error");
    expect(rank).not.toHaveBeenCalled();
  });
  it("completes missing original/lineup rankings and finalist heat on the server", async () => {
    const ctx = await resolved();
    const rank = vi.spyOn(ctx.qloo, "rank");
    const heat = vi.spyOn(ctx.qloo, "heat");
    const result = await finalise(ctx, submission());
    const replacement = ctx.resolved.get(direct.replacement)!.entity_id;
    const original = ctx.resolved.get(sample.cancelled_act.name)!.entity_id;
    const lineup = sample.lineup.map(a => ctx.resolved.get(a.name)!.entity_id);
    expect(rank).toHaveBeenCalledWith([replacement], [original], sample.city, ctx.signal);
    expect(rank).toHaveBeenCalledWith([replacement], lineup, sample.city, ctx.signal);
    expect(heat).toHaveBeenCalledWith(replacement, sample.city, ctx.signal);
    const completed = result.trace.filter(t => t.params.by === "server");
    expect(completed.map(t => t.tool).sort()).toEqual(["local_heat", "rank_against_audience", "rank_against_audience"]);
    expect(completed.every(t => t.status === "ok")).toBe(true);
    expect(result.plans[0].evidence.fit_lineup_audience).toContain("Synthetic pseudo-affinity");
    expect(result.plans[0].evidence.local_heat).toContain("Synthetic pseudo-affinity");
    expect(responseSchema.safeParse(result).success).toBe(true);
  });
  it("completes promotion fill fit and the exact remaining-lineup signals, with heat for both finalists", async () => {
    const ctx = await resolved();
    const replacement = ctx.resolved.get(promotion.replacement)!.entity_id;
    const promoted = ctx.resolved.get(promotion.promoted_act!)!.entity_id;
    const original = ctx.resolved.get(sample.cancelled_act.name)!.entity_id;
    const lineup = sample.lineup.map(a => ctx.resolved.get(a.name)!.entity_id);
    // A ranking against the whole bill cannot substitute for the remaining bill.
    await ctx.execute("rank_against_audience", { option_ids: [replacement], signal_ids: lineup, city: sample.city });
    const rank = vi.spyOn(ctx.qloo, "rank");
    const heat = vi.spyOn(ctx.qloo, "heat");
    const result = await finalise(ctx, submission([direct, promotion]));
    expect(rank).toHaveBeenCalledWith([replacement, promoted], [original], sample.city, ctx.signal);
    expect(rank).toHaveBeenCalledWith([replacement], [promoted], sample.city, ctx.signal);
    expect(rank).toHaveBeenCalledWith([replacement], lineup.filter(id => id !== promoted), sample.city, ctx.signal);
    expect(rank).toHaveBeenCalledTimes(3);
    expect(heat.mock.calls.map(call => call[0]).sort()).toEqual([promoted, replacement].sort());
    expect(result.plans[1].evidence.fit_original_audience).toContain(`filling ${promotion.promoted_act}'s slot: Synthetic pseudo-affinity`);
    expect(result.trace.filter(t => t.params.by === "server")).toHaveLength(5);
  });
  it("reuses observed evidence, including empty results, without redundant fetches", async () => {
    const ctx = await resolved();
    vi.spyOn(ctx.qloo, "rank").mockResolvedValue([]);
    vi.spyOn(ctx.qloo, "heat").mockResolvedValue([]);
    const first = await finalise(ctx, submission());
    expect(first.plans[0].evidence.fit_original_audience).toContain("No affinity data available");
    expect(first.plans[0].evidence.local_heat).toBe("No local heat evidence available.");
    expect(first.trace.filter(t => t.params.by === "server").every(t => t.status === "empty")).toBe(true);
    vi.mocked(ctx.qloo.rank).mockClear();
    vi.mocked(ctx.qloo.heat).mockClear();
    await finalise(ctx, submission());
    expect(ctx.qloo.rank).not.toHaveBeenCalled();
    expect(ctx.qloo.heat).not.toHaveBeenCalled();
  });
  it("keeps provider failures unknown and visible instead of rejecting the submission", async () => {
    const ctx = await resolved();
    vi.spyOn(ctx.qloo, "rank").mockRejectedValue(new Error("Synthetic unavailable"));
    vi.spyOn(ctx.qloo, "heat").mockRejectedValue(new Error("Synthetic unavailable"));
    const result = await finalise(ctx, submission([promotion]));
    expect(result.plans[0].evidence.fit_original_audience).toContain("No affinity data available");
    expect(result.plans[0].evidence.local_heat).toBe("No local heat evidence available.");
    expect(result.trace.filter(t => t.params.by === "server")).toHaveLength(5);
    expect(result.trace.filter(t => t.params.by === "server").every(t => t.status === "error")).toBe(true);
    expect(ctx.rankings).toEqual([]);
    expect(ctx.heats.size).toBe(0);
  });
  it("propagates cancellation during server completion", async () => {
    const controller = new AbortController();
    const ctx = new ToolContext(requestSchema.parse({ mode: "qloo", scenario: sample }), new MockQloo(), controller.signal);
    await ctx.execute("resolve_acts", { names: [...ctx.names] });
    vi.spyOn(ctx.qloo, "rank").mockImplementation(async () => { controller.abort(); throw controller.signal.reason; });
    await expect(finalise(ctx, submission())).rejects.toBeDefined();
    expect(ctx.trace.some(t => t.tool === "submit_rescue_plan")).toBe(false);
  });
});
describe("manual Anthropic loop", () => {
  it("uses exact SDK settings, preserves thinking blocks and re-prompts end_turn once", async () => {
    const ctx = context("baseline");
    const draft = await mockPlan(ctx);
    const thinking = { type: "thinking", thinking: "Synthetic thought", signature: "synthetic-signature" };
    const first = message("end_turn", [thinking, { type: "text", text: "Draft" }]);
    const send = vi.fn<MessageSender>().mockResolvedValueOnce(first).mockImplementationOnce(async params => {
      expect(params.messages[1]).toEqual({ role: "assistant", content: first.content });
      expect(params.messages[1].content).toBe(first.content);
      return message("tool_use", [{ type: "tool_use", id: "submit-1", name: "submit_rescue_plan", input: draft }]);
    });
    expect((await liveLoop(ctx, send)).plans.length).toBeGreaterThan(0);
    expect(send.mock.calls[0][0]).toMatchObject({ model: "claude-haiku-5-5", max_tokens: 16000, output_config: { effort: "medium" }, tool_choice: { type: "auto" } });
    expect(send.mock.calls[0][0]).not.toHaveProperty("thinking");
    expect(send.mock.calls[0][0].tools?.map(t => "name" in t ? t.name : "")).toEqual(["submit_rescue_plan"]);
  });
  it("returns tool results then accepts a complete submission", async () => {
    const ctx = context();
    const draft = submission([]);
    const send = vi.fn<MessageSender>().mockResolvedValueOnce(message("tool_use", [{ type: "tool_use", id: "resolve-1", name: "resolve_acts", input: { names: [...ctx.names] } }])).mockImplementationOnce(async params => {
      expect(params.messages.at(-1)?.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "tool_result", tool_use_id: "resolve-1" })]));
      return message("tool_use", [{ type: "tool_use", id: "submit-1", name: "submit_rescue_plan", input: draft }]);
    });
    expect((await liveLoop(ctx, send)).needs_input[0].name).toBe("Sample Twin Lantern");
  });
  it("omits resolution after preflight, gives final IDs first, and traces every model turn", async () => {
    const ctx = context("qloo", { scenario: { ...sample, candidates: [...sample.candidates, { name: "Sample Unknown", available: true, can_arrive_48h: true, notes: "" }] } });
    await ctx.execute("resolve_acts", { names: [...ctx.names] }, "server");
    const send = vi.fn<MessageSender>().mockImplementationOnce(async params => {
      expect(params.tools?.map(t => "name" in t ? t.name : "")).toEqual(["rank_against_audience", "local_heat", "submit_rescue_plan"]);
      const first = JSON.parse(params.messages[0].content as string);
      expect(first.resolved_ids).toContainEqual({ name: direct.replacement, entity_id: ctx.resolved.get(direct.replacement)!.entity_id });
      expect(first.resolution_notice).toContain("Resolved IDs are final");
      expect(first).not.toHaveProperty("server_envelope");
      expect(first.resolutions.some((r: { status: string }) => r.status === "ambiguous")).toBe(true);
      expect(first.resolutions.some((r: { status: string }) => r.status === "not_found")).toBe(true);
      return message("tool_use", [
        { type: "tool_use", id: "heat-1", name: "local_heat", input: { entity_id: ctx.resolved.get(direct.replacement)!.entity_id, region: sample.city } },
        { type: "tool_use", id: "heat-2", name: "local_heat", input: { entity_id: ctx.resolved.get(promotion.promoted_act!)!.entity_id, region: sample.city } },
      ]);
    }).mockResolvedValueOnce(message("tool_use", [{ type: "tool_use", id: "submit-1", name: "submit_rescue_plan", input: submission() }]));
    const result = await liveLoop(ctx, send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(result.trace.filter(t => t.tool === "model_turn")).toEqual([
      { tool: "model_turn", params: { turn: 1, stop_reason: "tool_use" }, status: "ok", ms: expect.any(Number), result_count: 2 },
      { tool: "model_turn", params: { turn: 2, stop_reason: "tool_use" }, status: "ok", ms: expect.any(Number), result_count: 1 },
    ]);
    expect(result.trace.every(t => t.ms >= 0)).toBe(true);
    expect(responseSchema.safeParse(result).success).toBe(true);
  });
  it("does not offer resolution when every name matched", async () => {
    const ctx = context("qloo", { resolutions: { "Sample Twin Lantern": "mock-artist-009" } });
    await ctx.execute("resolve_acts", { names: [...ctx.names] });
    expect(ctx.needsInput).toEqual([]);
    const send = vi.fn<MessageSender>().mockImplementation(async params => {
      expect(params.tools?.some(t => "name" in t && t.name === "resolve_acts")).toBe(false);
      return message("tool_use", [{ type: "tool_use", id: "submit", name: "submit_rescue_plan", input: submission() }]);
    });
    expect((await liveLoop(ctx, send)).plans).toHaveLength(1);
  });
  it.each([
    { label: "duplicate IDs", plans: [direct, direct], reason: "Plan IDs must be unique", plan_id: "A" },
    { label: "excluded replacement", plans: [{ ...direct, replacement: "Sample Glass Meadow" }], reason: "Ineligible replacement: Sample Glass Meadow", plan_id: "A" },
    { label: "invalid promotion", plans: [{ ...promotion, promoted_act: direct.replacement }], reason: "Invalid promotion path", plan_id: "B" },
    { label: "unresolved act", plans: [{ ...direct, replacement: "Sample Twin Lantern" }], reason: "Unresolved or unknown act: Sample Twin Lantern", plan_id: "A" },
    { label: "duplicate ticket", plans: [direct], reason: "Refund checklist must cover every supplied ticket type exactly once", plan_id: null },
    { label: "missing ticket", plans: [direct], reason: "Refund checklist must cover every supplied ticket type exactly once", plan_id: null },
    { label: "unknown ticket", plans: [direct], reason: "Refund checklist must cover every supplied ticket type exactly once", plan_id: null },
    { label: "oversized rationale", plans: [{ ...direct, rationale: "x".repeat(601) }], reason: "plans.0.rationale:", plan_id: "A" },
  ])("returns specific hard-error feedback for $label and accepts a corrected submission", async ({ label, plans, reason, plan_id }) => {
    const ctx = await resolved();
    const invalid = submission(plans);
    if (label === "duplicate ticket") invalid.refund_checklist[1] = invalid.refund_checklist[0];
    if (label === "missing ticket") invalid.refund_checklist.pop();
    if (label === "unknown ticket") invalid.refund_checklist[0].ticket_type = "Unknown ticket";
    const rank = vi.spyOn(ctx.qloo, "rank");
    const send = vi.fn<MessageSender>().mockResolvedValueOnce(message("tool_use", [{ type: "tool_use", id: "invalid", name: "submit_rescue_plan", input: invalid }]))
      .mockImplementationOnce(async params => {
        const content = params.messages.at(-1)!.content;
        expect(Array.isArray(content)).toBe(true);
        const result = (content as { type: string; is_error: boolean; content: string }[])[0];
        expect(result).toMatchObject({ type: "tool_result", is_error: true });
        expect(JSON.parse(result.content)).toEqual({ error: expect.stringContaining(reason), plan_id });
        expect(rank).not.toHaveBeenCalled();
        return message("tool_use", [{ type: "tool_use", id: "corrected", name: "submit_rescue_plan", input: submission() }]);
      });
    expect((await liveLoop(ctx, send)).plans).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it.each(["refusal", "max_tokens"] as const)("clearly errors on %s without fallback", async reason => {
    const ctx = context("baseline");
    const send = vi.fn<MessageSender>().mockResolvedValue(message(reason));
    await expect(liveLoop(ctx, send)).rejects.toMatchObject({ code: reason });
    expect(ctx.trace.at(-1)).toMatchObject({ tool: "model_turn", status: "error", result_count: 0 });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("records failed model requests without exposing provider errors", async () => {
    const ctx = context("baseline");
    const send = vi.fn<MessageSender>().mockRejectedValue(new Error("Synthetic provider detail"));
    await expect(liveLoop(ctx, send)).rejects.toMatchObject({ code: "provider" });
    expect(ctx.trace).toEqual([{ tool: "model_turn", params: { turn: 1 }, status: "error", ms: expect.any(Number), result_count: 0 }]);
  });
  it("continues pause_turn at most eight turns, passing full assistant content", async () => {
    const send = vi.fn<MessageSender>().mockResolvedValue(message("pause_turn", [{ type: "text", text: "Paused" }]));
    await expect(liveLoop(context("baseline"), send)).rejects.toMatchObject({ code: "unfinished" });
    expect(send).toHaveBeenCalledTimes(8);
  });
  it("rejects a second end_turn after the single re-prompt", async () => {
    const send = vi.fn<MessageSender>().mockResolvedValue(message("end_turn"));
    await expect(liveLoop(context("baseline"), send)).rejects.toMatchObject({ code: "unfinished" });
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("honours abort without attempting a model call", async () => {
    const ctx = new ToolContext(requestSchema.parse({ mode: "baseline", scenario: sample }), new MockQloo(), AbortSignal.abort());
    const send = vi.fn<MessageSender>();
    await expect(liveLoop(ctx, send)).rejects.toBeDefined();
    expect(send).not.toHaveBeenCalled();
  });
  it("all JSON-schema tool objects have additionalProperties false", () => {
    function visit(value: unknown) {
      if (!value || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      if (record.type === "object") expect(record.additionalProperties).toBe(false);
      for (const item of Object.values(record)) visit(item);
    }
    for (const tool of definitions("qloo")) {
      expect(tool.strict).toBe(true);
      visit(tool.input_schema);
    }
  });
});
