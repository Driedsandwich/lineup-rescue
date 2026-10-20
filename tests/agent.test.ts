import { describe, expect, it, vi } from "vitest";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import sample from "../samples/scenario.json";
import { requestSchema, responseSchema, type RescueRequest } from "../src/lib/contracts";
import { filterCandidates } from "../src/lib/agent/constraints";
import { ToolContext, definitions } from "../src/lib/agent/tools";
import { finalise, envelope } from "../src/lib/agent/plans";
import { mockPlan } from "../src/lib/agent/mock";
import { liveLoop, runAgent, type MessageSender } from "../src/lib/agent/loop";
import { MockQloo } from "../src/lib/qloo/mock";

function context(mode: "qloo" | "baseline" = "qloo", changes: Partial<RescueRequest> = {}) {
  return new ToolContext(requestSchema.parse({ mode, scenario: sample, ...changes }), new MockQloo(), new AbortController().signal);
}
async function resolved() { const ctx = context(); await ctx.execute("resolve_acts", { names: [...ctx.names] }); return ctx; }
const message = (stop_reason: Message["stop_reason"], content: unknown[] = []) => ({ id: "synthetic-message", type: "message", role: "assistant", model: "claude-haiku-5-5", stop_reason, content, stop_sequence: null, usage: {} }) as unknown as Message;

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
    const result = finalise(ctx, await mockPlan(ctx));
    expect(search).not.toHaveBeenCalled();
    expect(result.trace.map(t => t.tool)).toEqual(["submit_rescue_plan"]);
    expect(result.plans.every(p => p.evidence.fit_original_audience.includes("guess"))).toBe(true);
    expect(result.needs_input).toEqual([]);
  });
  it("keeps scenario names when ranking results return different catalog labels", async () => {
    const ctx = await resolved();
    const mock = new MockQloo();
    vi.spyOn(ctx.qloo, "rank").mockImplementation(async (options, signals, city) => (await mock.rank(options, signals, city)).map(entity => ({ ...entity, name: `${entity.name} (catalog label)` })));
    const result = finalise(ctx, await mockPlan(ctx));
    expect(result.plans).toHaveLength(3);
    expect(result.plans.every(p => sample.candidates.some(a => a.name === p.replacement))).toBe(true);
    expect(sample.lineup.some(a => a.name === result.plans[2].promoted_act)).toBe(true);
  });
  it("rejects excluded replacements and overwrites invented evidence", async () => {
    const ctx = await resolved();
    const draft = await mockPlan(ctx);
    draft.plans[0].replacement = "Sample Glass Meadow";
    expect(() => finalise(ctx, draft)).toThrow("ineligible");
    const fresh = await mockPlan(ctx);
    fresh.plans[0].evidence.fit_original_audience = "Guaranteed 99% ticket sales";
    expect(finalise(ctx, fresh).plans[0].evidence.fit_original_audience).not.toContain("Guaranteed");
  });
  it("does not score missing catalog acts or fabricate plans with no eligible options", async () => {
    const ctx = context("qloo", { scenario: { ...sample, cancelled_act: { ...sample.cancelled_act, name: "Sample Unknown Headliner" }, candidates: [] } });
    await ctx.execute("resolve_acts", { names: [...ctx.names] });
    const result = finalise(ctx, await mockPlan(ctx));
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
    const draft = envelope(ctx, []);
    const send = vi.fn<MessageSender>().mockResolvedValueOnce(message("tool_use", [{ type: "tool_use", id: "resolve-1", name: "resolve_acts", input: { names: [...ctx.names] } }])).mockImplementationOnce(async params => {
      expect(params.messages.at(-1)?.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "tool_result", tool_use_id: "resolve-1" })]));
      return message("tool_use", [{ type: "tool_use", id: "submit-1", name: "submit_rescue_plan", input: draft }]);
    });
    expect((await liveLoop(ctx, send)).needs_input[0].name).toBe("Sample Twin Lantern");
  });
  it.each(["refusal", "max_tokens"] as const)("clearly errors on %s without fallback", async reason => {
    const send = vi.fn<MessageSender>().mockResolvedValue(message(reason));
    await expect(liveLoop(context("baseline"), send)).rejects.toMatchObject({ code: reason });
    expect(send).toHaveBeenCalledTimes(1);
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
