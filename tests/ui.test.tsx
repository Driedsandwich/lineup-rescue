import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import RescueForm from "../src/app/rescue-form";
import ResultPanel, { EvidenceMeter } from "../src/app/result-panel";
import { runAgent } from "../src/lib/agent/loop";
import { comparePlans, sampleForMode } from "../src/lib/presentation";

it("renders mode-aware running orders, accessible actions and the inline editor", () => {
  for (const mode of ["mock", "live"] as const) {
    const html = renderToStaticMarkup(createElement(RescueForm, { initialStatus: { qloo: mode, llm: "mock" } }));
    expect(html).toContain(`<del>${sampleForMode(mode).cancelled_act.name}</del>`);
    expect(html).toContain("Compare with LLM-only");
    expect(html).toContain('id="scenario-editor"');
    expect(html).toContain("role=\"status\"");
    const notice = "Fictional scenario for demonstration. Artist names are used only to look up public taste data; no real cancellation or booking is implied.";
    expect(html.includes(notice)).toBe(mode === "live");
    expect(html).toContain(mode === "mock" ? "Sample data" : "Live Qloo");
  }
});

it("renders per-act radio choices, missing catalog copy, diff labels and editable drafts", async () => {
  const scenario = sampleForMode("mock");
  scenario.candidates.push({ name: "Sample Unknown", available: true, can_arrive_48h: true, notes: "" });
  const qloo = await runAgent({ mode: "qloo", scenario }, new AbortController().signal);
  const baseline = await runAgent({ mode: "baseline", scenario }, new AbortController().signal);
  const differences = comparePlans(qloo.plans, baseline.plans);
  const props = { cancelledActName: scenario.cancelled_act.name, differences, busy: true, pendingChoices: false, resolutions: {}, choose: () => {}, rerun: () => {} };
  const html = renderToStaticMarkup(createElement(ResultPanel, { ...props, result: qloo }));
  expect(html).toContain('type="radio"');
  expect(html).toContain('name="resolution-Sample Twin Lantern"');
  expect(html).toContain("disabled");
  expect(html).toContain("Qloo does not know this act yet; it was not scored.");
  expect(html).toContain("Different choice at this position");
  expect(html).toContain("Tool trace");
  expect(html).toContain("Short social post");
  expect(html).not.toContain("Choose the catalog match for the cancelled act above, then re-run.");
  expect(html).not.toContain("The cancelled act was not found in Qloo");
  const control = renderToStaticMarkup(createElement(ResultPanel, { ...props, result: baseline }));
  expect(control).toContain("No audience evidence");
  expect(control).not.toContain("<meter");
});

it("renders unknown evidence without a numeric meter and labels actual affinity accessibly", () => {
  const unknown = renderToStaticMarkup(createElement(EvidenceMeter, { label: "Local heat", text: "No local heat evidence available.", baseline: false }));
  expect(unknown).toContain("UNKNOWN"); expect(unknown).not.toContain("<meter");
  const measured = renderToStaticMarkup(createElement(EvidenceMeter, { label: "Local heat", text: "Qloo affinity 0.500 (not a probability)", baseline: false }));
  expect(measured).toContain('aria-label="Local heat: affinity 0.500, not a probability"');
  const areas = renderToStaticMarkup(createElement(EvidenceMeter, { label: "Local heat", text: "3 areas in Austin, TX with local affinity (top 1.000, not a probability)", baseline: false }));
  expect(areas).toContain("3 AREAS"); expect(areas).not.toContain("UNKNOWN"); expect(areas).not.toContain("<meter");
  const one = renderToStaticMarkup(createElement(EvidenceMeter, { label: "Local heat", text: "1 area in Austin, TX with local affinity (top 1.000, not a probability)", baseline: false }));
  expect(one).toContain("1 AREA<");
});

it.each([
  ["Sample Twin Lantern", "Choose the catalog match for the cancelled act above, then re-run."],
  ["Sample Unknown", "The cancelled act was not found in Qloo&#x27;s catalog, so its audience cannot be compared. Check the spelling or try another act."],
])("explains why plans cannot be ranked for the unresolved cancelled act %s", async (name, notice) => {
  const scenario = sampleForMode("mock");
  scenario.candidates = scenario.candidates.filter(act => act.name !== name);
  scenario.cancelled_act.name = name;
  const result = await runAgent({ mode: "qloo", scenario }, new AbortController().signal);
  expect(result.plans).toEqual([]);
  const html = renderToStaticMarkup(createElement(ResultPanel, { result, cancelledActName: name, differences: [], busy: false,
    pendingChoices: false, resolutions: {}, choose: () => {}, rerun: () => {} }));
  expect(html).toContain(notice);
  expect(html.indexOf(notice)).toBeGreaterThan(html.indexOf('class="plan-stack"'));
  expect(html).not.toContain("No supported plan. Resolve the names above or update the phone list.");
});

it("distinguishes model-turn latency from server-initiated evidence calls in the trace", async () => {
  const result = await runAgent({ mode: "baseline", scenario: sampleForMode("mock") }, new AbortController().signal);
  result.trace = [
    { tool: "model_turn", params: { turn: 2 }, status: "ok", result_count: 1, ms: 14000 },
    { tool: "local_heat", params: { by: "server" }, status: "empty", result_count: 0, ms: 12 },
  ];
  const html = renderToStaticMarkup(createElement(ResultPanel, { result, cancelledActName: sampleForMode("mock").cancelled_act.name, differences: [], busy: false, pendingChoices: false, resolutions: {}, choose: () => {}, rerun: () => {} }));
  expect(html).toContain("2 entries");
  expect(html).toContain("Model turn 2");
  expect(html).toContain("1 tool calls requested / 14000 ms");
  expect(html).toContain("local_heat (server)");
  expect(html).toContain("0 results / 12 ms");
});

it("renders fallback as a calm status notice with plans and model timings", async () => {
  for (const mode of ["qloo", "baseline"] as const) {
    const result = await runAgent({ mode, scenario: sampleForMode("mock") }, new AbortController().signal, {
      send: async () => { throw new Error("synthetic provider failure"); },
    });
    const html = renderToStaticMarkup(createElement(ResultPanel, { result, cancelledActName: sampleForMode("mock").cancelled_act.name, differences: [], busy: false, pendingChoices: false, resolutions: {}, choose: () => {}, rerun: () => {} }));
    expect(result.llm).toBe("fallback");
    expect(html).toContain('class="notice" role="status"');
    expect(html).toContain("Plans assembled with fixed rules.");
    expect(html).toContain(mode === "qloo" ? "assembled by fixed rules from the same Qloo evidence." : "no Qloo evidence was used.");
    expect(html).toContain("Planner / fallback");
    expect(html).toContain("Model turn 1");
    expect(html).toContain("PLAN 01");
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("synthetic provider failure");
  }
});
