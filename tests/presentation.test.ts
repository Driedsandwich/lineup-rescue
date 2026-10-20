import { describe, expect, it, vi } from "vitest";
import { comparePlans, evidenceValue, recoveryAdvice, rescuePayload, runningOrder, sampleForMode } from "../src/lib/presentation";
import { requestRescue } from "../src/lib/rescue-client";
import { requestSchema, scenarioSchema, type Plan } from "../src/lib/contracts";
import { POST } from "../src/app/api/rescue/route";
import { filterCandidates } from "../src/lib/agent/constraints";

const plan: Plan = { id: "A", title: "Direct swap", type: "direct_swap", replacement: "Sample One", promoted_act: null, evidence: { fit_original_audience: "Unknown", fit_lineup_audience: "Unknown", local_heat: "Unknown" }, rationale: "Check fit.", caveats: [] };

describe("plan-position comparison", () => {
  it("compares choices rather than generated IDs, titles or evidence", () => {
    expect(comparePlans([plan], [{ ...plan, id: "other", title: "New copy", evidence: { ...plan.evidence, local_heat: "No data" } }])[0].status).toBe("same");
    expect(comparePlans([plan], [{ ...plan, replacement: "Sample Two" }])[0].status).toBe("different");
  });
  it("detects a changed promoted act, fill act or plan type even if the other role agrees", () => {
    const promotion: Plan = { ...plan, type: "promote_and_fill", promoted_act: "Sample Lineup" };
    for (const other of [{ ...promotion, replacement: "Sample Fill" }, { ...promotion, promoted_act: "Sample Another" }, plan]) {
      expect(comparePlans([promotion], [other])[0].status).toBe("different");
    }
  });
  it("retains returned order and marks absent counterparts, including empty runs", () => {
    const second = { ...plan, id: "B", replacement: "Sample Two" };
    expect(comparePlans([plan, second], [second, plan]).map(row => row.status)).toEqual(["different", "different"]);
    expect(comparePlans([plan, second], [plan]).map(row => row.status)).toEqual(["same", "missing"]);
    expect(comparePlans([], [plan])[0]).toMatchObject({ position: 1, status: "missing", qloo: undefined });
    expect(comparePlans([], [])).toEqual([]);
  });
});

describe("mode-aware samples and honest meters", () => {
  it("loads synthetic Bristol or real-name Austin, with no shared mutable state", () => {
    const mock = sampleForMode("mock"); const live = sampleForMode("live");
    expect(scenarioSchema.safeParse(mock).success).toBe(true);
    expect(scenarioSchema.safeParse(live).success).toBe(true);
    expect(mock.city).toBe("Bristol, UK"); expect(live.city).toBe("Austin, TX");
    expect(live.cancelled_act.name).toBe("The Killers");
    expect(filterCandidates(live.candidates).excluded).toHaveLength(2);
    expect(JSON.stringify(live)).not.toMatch(/@|\+\d{8}|[0-9a-f]{8}-[0-9a-f]{4}-/i);
    live.cancelled_act.name = "Changed";
    expect(sampleForMode("live").cancelled_act.name).toBe("The Killers");
  });
  it("groups by stage, preserves the cancelled slot and accepts unstructured slots", () => {
    const scenario = sampleForMode("mock");
    const groups = runningOrder(scenario);
    expect(groups[0].stage).toBe("Main");
    expect(groups[0].acts.map(act => act.cancelled)).toEqual([false, true]);
    expect(groups[0].acts[1].slot).toBe("21:00–22:30");
    scenario.cancelled_act.slot = "TBC";
    expect(runningOrder(scenario).at(-1)).toMatchObject({ stage: "Cancelled slot", acts: [{ name: scenario.cancelled_act.name, slot: "TBC", cancelled: true }] });
  });
  it("uses only a present bounded affinity and never turns missing evidence into zero", () => {
    expect(evidenceValue("Act: Synthetic pseudo-affinity 0.450 (not a probability)")).toBe(.45);
    expect(evidenceValue("Qloo affinity 0.000 (not a probability)")).toBe(0);
    for (const text of ["No affinity data available", "LLM-only guess; no audience data.", "Qloo affinity -0.5", "Qloo affinity 1.5"]) expect(evidenceValue(text)).toBeNull();
  });
});

describe("client request and recovery flow", () => {
  it("serialises inline resolutions, then resolves the actual mock route without provider network", async () => {
    const scenario = sampleForMode("mock");
    const requests: ReturnType<typeof rescuePayload>[] = [];
    const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)); requests.push(body);
      return POST(new Request("http://localhost/api/rescue", { ...init, headers: { ...init?.headers, "x-forwarded-for": "presentation-flow" } }));
    });
    const first = await requestRescue("qloo", scenario, {}, transport);
    const act = first.needs_input[0];
    const selected = { [act.name]: act.options[1].entity_id, "Unselected": "" };
    const rerun = await requestRescue("qloo", scenario, selected, transport);
    const baseline = await requestRescue("baseline", scenario, selected, transport);
    expect(requestSchema.safeParse(requests[1]).success).toBe(true);
    expect(requests[1].resolutions).toEqual({ [act.name]: act.options[1].entity_id });
    expect(rerun.needs_input).toEqual([]);
    expect(requests[1].scenario).toEqual(requests[2].scenario);
    expect(requests[1].resolutions).toEqual(requests[2].resolutions);
    expect(baseline.trace.map(entry => entry.tool)).toEqual(["submit_rescue_plan"]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    [400, { message: "Invalid input", issues: [{ path: "scenario.city", message: "Required" }] }, "scenario.city: Required"],
    [429, { message: "Limit reached" }, "Wait 2 minute(s)"],
    [429, { error: "daily_cap", message: "Daily cap" }, "00:00 UTC"],
    [502, { message: "Provider failed" }, "check provider access"],
    [504, { message: "Deadline" }, "smaller phone list"],
  ])("gives recovery advice for HTTP %i", async (status, body, expected) => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status, headers: { "Retry-After": "120" } }));
    await expect(requestRescue("qloo", sampleForMode("mock"), {}, transport)).rejects.toThrow(expected);
  });
  it("handles network and non-JSON failures without losing the scenario", async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(new Response("upstream html", { status: 503 }));
    await expect(requestRescue("qloo", sampleForMode("mock"), {}, transport)).rejects.toThrow("Your scenario is still here");
    await expect(requestRescue("qloo", sampleForMode("mock"), {}, transport)).rejects.toThrow("503");
    expect(recoveryAdvice(429, null)).toContain("10 minutes");
    expect(recoveryAdvice(413, null)).toContain("64 KiB");
  });
});
