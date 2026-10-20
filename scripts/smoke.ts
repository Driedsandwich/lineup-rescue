import assert from "node:assert/strict";

// Override inherited modes/keys before imports, and disallow ALL network calls.
process.env.QLOO_MODE = "mock";
process.env.LLM_MODE = "mock";
process.env.QLOO_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
globalThis.fetch = async () => { throw new Error("Smoke must never access the network"); };

async function main() {
  const { POST } = await import("../src/app/api/rescue/route");
  const { responseSchema } = await import("../src/lib/contracts");
  const { default: scenario } = await import("../samples/scenario.json");
  const required = ["run_id", "mode", "data_source", "llm", "excluded", "needs_input", "not_in_catalog", "plans", "announcement", "refund_checklist", "trace", "disclaimers"].sort();
  for (const mode of ["qloo", "baseline"] as const) {
    const response = await POST(new Request("http://localhost/api/rescue", { method: "POST", headers: { "Content-Type": "application/json", "x-forwarded-for": "smoke-local" }, body: JSON.stringify({ mode, scenario }) }));
    assert.equal(response.status, 200);
    const body = responseSchema.parse(await response.json());
    assert.deepEqual(Object.keys(body).sort(), required);
    assert.equal(body.mode, mode);
    assert.equal(body.data_source, "mock");
    assert.equal(body.llm, "mock");
    assert.equal(body.plans.length, 3);
    assert.equal(body.trace.at(-1)?.tool, "submit_rescue_plan");
    assert.equal(body.refund_checklist.length, scenario.ticket_types.length);
    assert.equal(body.trace.some(t => t.tool === "rank_against_audience"), mode === "qloo");
    console.log(`PASS ${mode}: complete contract, ${body.plans.length} plans, ${body.trace.length} tool calls, no network`);
  }
}
main().catch(() => { console.error("FAIL smoke: contract or execution assertion failed"); process.exitCode = 1; });
