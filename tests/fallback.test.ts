import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import sample from "../samples/scenario.json";
import { responseSchema, type RescueRequest } from "../src/lib/contracts";
import { MODEL_BUDGET_MS, runAgent, type MessageSender } from "../src/lib/agent/loop";
import { MockQloo } from "../src/lib/qloo/mock";
import * as qloo from "../src/lib/qloo";

const request: RescueRequest = { mode: "qloo", scenario: sample };
const message = (stop_reason: Message["stop_reason"], content: unknown[] = []) => ({ stop_reason, content }) as Message;
afterEach(() => vi.restoreAllMocks());

describe("deterministic recovery from live model failures", () => {
  it.each(["provider", "refusal", "max_tokens", "unfinished"] as const)("returns the public contract on %s, preserving trace and constraints", async reason => {
    const send = vi.fn<MessageSender>();
    if (reason === "provider") send.mockRejectedValue(new Error("synthetic-private-provider-body"));
    else send.mockResolvedValue(message(reason === "unfinished" ? "end_turn" : reason));
    const result = responseSchema.parse(await runAgent(request, new AbortController().signal, { send }));
    expect(result.llm).toBe("fallback");
    expect(result.plans).toHaveLength(3);
    expect(result.plans.every(p => sample.candidates.some(c => c.name === p.replacement && c.available && c.can_arrive_48h))).toBe(true);
    expect(result.needs_input.map(a => a.name)).toContain("Sample Twin Lantern");
    expect(result.plans.some(p => p.replacement === "Sample Twin Lantern")).toBe(false);
    expect(result.trace).toContainEqual(expect.objectContaining({ tool: "model_turn" }));
    expect(result.trace).toContainEqual(expect.objectContaining({ tool: "fallback", params: { reason, budget_ms: MODEL_BUDGET_MS } }));
    expect(result.disclaimers.join(" ")).toContain("assembled by fixed rules from the same Qloo evidence");
    expect(JSON.stringify(result)).not.toContain("synthetic-private-provider-body");
  });

  it("aborts a sender that ignores cancellation at 40 seconds and keeps its elapsed model turn", async () => {
    vi.useFakeTimers();
    const send = vi.fn<MessageSender>(() => new Promise(() => {}));
    const controller = new AbortController();
    let settled = false;
    const run = runAgent(request, controller.signal, { send }).then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(MODEL_BUDGET_MS - 1);
    expect(settled).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    const modelSignal = send.mock.calls[0][1];
    expect(modelSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = responseSchema.parse(await run);
    expect(result.llm).toBe("fallback");
    expect(modelSignal.aborted).toBe(true);
    expect(controller.signal.aborted).toBe(false);
    expect(result.trace).toContainEqual(expect.objectContaining({ tool: "model_turn", status: "error", ms: MODEL_BUDGET_MS }));
    expect(result.plans).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a late model reply after fallback without starting its tools", async () => {
    vi.useFakeTimers();
    let reply!: (message: Message) => void;
    const send = vi.fn<MessageSender>(() => new Promise(resolve => { reply = resolve; }));
    const run = runAgent(request, new AbortController().signal, { send, modelBudgetMs: 25 });
    await vi.advanceTimersByTimeAsync(25);
    const result = await run;
    const trace = JSON.stringify(result.trace);
    reply(message("tool_use", [{ type: "tool_use", name: "local_heat", id: "late", input: {} }]));
    await vi.advanceTimersByTimeAsync(1);
    expect(result.llm).toBe("fallback");
    expect(JSON.stringify(result.trace)).toBe(trace);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("reuses live-source observations even when a different ranking arrived first", async () => {
    vi.useFakeTimers();
    const fixture = new MockQloo();
    // Synthetic fixtures only; labelling the injected client live checks that
    // recovery never silently substitutes a MockQloo or changes provenance.
    const client = { source: "live" as const, search: vi.fn(fixture.search.bind(fixture)), rank: vi.fn(fixture.rank.bind(fixture)), heat: vi.fn(fixture.heat.bind(fixture)) };
    const factory = vi.spyOn(qloo, "createQloo").mockReturnValue(client);
    const options = (await Promise.all(sample.candidates.filter(c => c.available && c.can_arrive_48h).map(c => fixture.search(c.name)))).filter(acts => acts.length === 1).flat().map(a => a.entity_id);
    const original = (await fixture.search(sample.cancelled_act.name))[0].entity_id;
    const lineup = (await Promise.all(sample.lineup.map(a => fixture.search(a.name)))).flat().map(a => a.entity_id);
    const ranked = await fixture.rank(options, [original], sample.city);
    const send = vi.fn<MessageSender>().mockResolvedValueOnce(message("tool_use", [
      { type: "tool_use", id: "lineup-first", name: "rank_against_audience", input: { option_ids: options, signal_ids: lineup, city: sample.city } },
      { type: "tool_use", id: "original-second", name: "rank_against_audience", input: { option_ids: options, signal_ids: [original], city: sample.city } },
      { type: "tool_use", id: "heat", name: "local_heat", input: { entity_id: ranked[0].entity_id, region: sample.city } },
    ])).mockImplementation(() => new Promise(() => {}));
    const run = runAgent(request, new AbortController().signal, { send });
    await vi.advanceTimersByTimeAsync(MODEL_BUDGET_MS);
    const result = responseSchema.parse(await run);
    expect(result.llm).toBe("fallback");
    expect(result.data_source).toBe("live");
    expect(factory).toHaveBeenCalledTimes(1);
    expect(result.plans[0].replacement).toBe(ranked[0].name);
    expect(result.plans[0].evidence.fit_original_audience).toContain(`Qloo affinity ${ranked[0].affinity!.toFixed(3)}`);
    expect(client.rank.mock.calls.filter(([, signals]) => signals.length === 1 && signals[0] === original)).toHaveLength(2); // candidate ranking and promotion ranking only
    expect(client.rank.mock.calls.filter(([ids, signals]) => ids.includes(ranked[0].entity_id) && signals.length === 1 && signals[0] === original)).toHaveLength(1);
    expect(client.heat.mock.calls.filter(([id]) => id === ranked[0].entity_id)).toHaveLength(1);
    expect(client.search).toHaveBeenCalledTimes(new Set([sample.cancelled_act.name, ...sample.lineup.map(a => a.name), ...sample.candidates.filter(c => c.available && c.can_arrive_48h).map(c => c.name)]).size);
    expect(result.trace.filter(t => t.tool === "model_turn")).toHaveLength(2);
  });

  it("reuses empty rankings without inferring evidence or supported plans", async () => {
    const fixture = new MockQloo();
    const client = { source: "live" as const, search: fixture.search.bind(fixture), rank: vi.fn(async () => []), heat: vi.fn(async () => []) };
    vi.spyOn(qloo, "createQloo").mockReturnValue(client);
    const send: MessageSender = async params => {
      const first = JSON.parse(params.messages[0].content as string);
      if (params.messages.length > 1) throw new Error("synthetic provider failure");
      const candidates = first.resolved_ids.filter((a: { name: string }) => sample.candidates.some(c => c.name === a.name));
      const original = first.resolved_ids.find((a: { name: string }) => a.name === sample.cancelled_act.name);
      return message("tool_use", [{ type: "tool_use", id: "empty", name: "rank_against_audience", input: { option_ids: candidates.map((a: { entity_id: string }) => a.entity_id), signal_ids: [original.entity_id], city: sample.city } }]);
    };
    const result = responseSchema.parse(await runAgent(request, new AbortController().signal, { send }));
    expect(result.llm).toBe("fallback");
    expect(result.plans).toEqual([]);
    expect(client.rank).toHaveBeenCalledTimes(3); // original, lineup, promotion; original is not refetched
  });

  it("baseline fallback makes no Qloo calls and describes its ungrounded fixed rules", async () => {
    const search = vi.spyOn(MockQloo.prototype, "search");
    const result = responseSchema.parse(await runAgent({ ...request, mode: "baseline" }, new AbortController().signal, { send: async () => message("refusal") }));
    expect(result.llm).toBe("fallback");
    expect(result.disclaimers.join(" ")).toContain("no Qloo evidence was used");
    expect(result.plans[0].evidence.fit_original_audience).toContain("Fixed-rule");
    expect(search).not.toHaveBeenCalled();
  });

  it("does not turn request cancellation into a fallback result", async () => {
    const controller = new AbortController();
    const send: MessageSender = async () => { controller.abort(); return new Promise(() => {}); };
    await expect(runAgent(request, controller.signal, { send })).rejects.toMatchObject({ code: "deadline", trace: expect.arrayContaining([expect.objectContaining({ tool: "model_turn" })]) });
  });
});
