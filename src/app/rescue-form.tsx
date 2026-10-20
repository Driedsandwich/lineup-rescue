"use client";

import { useState } from "react";
import sample from "../../samples/scenario.json";
import type { RescueResponse, Scenario } from "../lib/contracts";

type Mode = "qloo" | "baseline";
type Props = { sampleData: boolean; mockPlanner: boolean };
export default function RescueForm({ sampleData, mockPlanner }: Props) {
  const [scenario, setScenario] = useState<Scenario>(sample);
  const [results, setResults] = useState<Partial<Record<Mode, RescueResponse>>>({});
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Mode | null>(null);
  const [error, setError] = useState("");
  function edit(next: Scenario) { setScenario(next); setResults({}); setResolutions({}); setError(""); }
  async function run(mode: Mode) {
    setBusy(mode); setError("");
    try {
      const response = await fetch("/api/rescue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode, scenario, resolutions }) });
      const body = await response.json();
      if (!response.ok) throw new Error(`${body.message ?? "Request failed"}${body.issues ? ` ${body.issues.map((i: { path: string; message: string }) => `${i.path}: ${i.message}`).join("; ")}` : ""}`);
      setResults(previous => ({ ...previous, [mode]: body }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Request failed. Please retry."); }
    finally { setBusy(null); }
  }
  return <>
    {sampleData && <p className="banner"><strong>Sample data</strong> — fictional acts and synthetic pseudo-affinity. No live Qloo results.</p>}
    {mockPlanner && <p className="notice">Deterministic sample planner is active. No Anthropic requests are made.</p>}
    <p id="privacy">Use public act names only. Do not enter personal data. Booker notes are sent only to the language model, never to Qloo.</p>
    <form onSubmit={event => { event.preventDefault(); void run("qloo"); }} aria-describedby="privacy">
      <fieldset disabled={busy !== null}>
        <legend>1 · The festival</legend>
        <div className="fields">
          <label>Festival name<input required maxLength={200} value={scenario.festival_name} onChange={e => edit({ ...scenario, festival_name: e.target.value })} /></label>
          <label>City<input required maxLength={200} value={scenario.city} onChange={e => edit({ ...scenario, city: e.target.value })} /></label>
          <label>Festival date<input required type="date" value={scenario.date} onChange={e => edit({ ...scenario, date: e.target.value })} /></label>
          <label>Cancelled act<input required maxLength={200} value={scenario.cancelled_act.name} onChange={e => edit({ ...scenario, cancelled_act: { ...scenario.cancelled_act, name: e.target.value } })} /></label>
          <label>Cancelled slot<input required maxLength={200} value={scenario.cancelled_act.slot} onChange={e => edit({ ...scenario, cancelled_act: { ...scenario.cancelled_act, slot: e.target.value } })} /></label>
        </div>
      </fieldset>
      <fieldset disabled={busy !== null}>
        <legend>2 · Remaining lineup ({scenario.lineup.length}/20)</legend>
        {scenario.lineup.map((act, index) => <div className="row" key={index}>
          {(["name", "stage", "slot"] as const).map(field => <label key={field}>{field === "name" ? "Act name" : field === "stage" ? "Stage" : "Time slot"}<input required maxLength={200} value={act[field]} onChange={e => edit({ ...scenario, lineup: scenario.lineup.map((item, i) => i === index ? { ...item, [field]: e.target.value } : item) })} /></label>)}
          <button type="button" aria-label={`Remove lineup act ${index + 1}`} onClick={() => edit({ ...scenario, lineup: scenario.lineup.filter((_, i) => i !== index) })}>Remove</button>
        </div>)}
        <button type="button" disabled={scenario.lineup.length >= 20} onClick={() => edit({ ...scenario, lineup: [...scenario.lineup, { name: "", stage: "", slot: "" }] })}>Add lineup act</button>
      </fieldset>
      <fieldset disabled={busy !== null}>
        <legend>3 · The phone list ({scenario.candidates.length}/12)</legend>
        <p>Availability and arrival with crew and gear are hard constraints. Recorded travel over 48 hours also excludes an act.</p>
        {scenario.candidates.map((candidate, index) => <fieldset className="candidate" key={index}>
          <legend>Candidate {index + 1}</legend>
          <div className="fields">
            <label>Act name<input required maxLength={200} value={candidate.name} onChange={e => edit({ ...scenario, candidates: scenario.candidates.map((item, i) => i === index ? { ...item, name: e.target.value } : item) })} /></label>
            <label className="check"><input type="checkbox" checked={candidate.available} onChange={e => edit({ ...scenario, candidates: scenario.candidates.map((item, i) => i === index ? { ...item, available: e.target.checked } : item) })} />Available</label>
            <label className="check"><input type="checkbox" checked={candidate.can_arrive_48h} onChange={e => edit({ ...scenario, candidates: scenario.candidates.map((item, i) => i === index ? { ...item, can_arrive_48h: e.target.checked } : item) })} />Can arrive in 48 h with crew and gear</label>
            <label>Travel time (hours, optional)<input type="number" min={0} max={1000} step="any" value={candidate.travel_hours ?? ""} onChange={e => edit({ ...scenario, candidates: scenario.candidates.map((item, i) => i === index ? { ...item, travel_hours: e.target.value === "" ? undefined : Number(e.target.value) } : item) })} /></label>
            <label>Booker notes (200 characters maximum)<textarea maxLength={200} value={candidate.notes} onChange={e => edit({ ...scenario, candidates: scenario.candidates.map((item, i) => i === index ? { ...item, notes: e.target.value } : item) })} /></label>
          </div>
          <button type="button" aria-label={`Remove candidate ${index + 1}`} onClick={() => edit({ ...scenario, candidates: scenario.candidates.filter((_, i) => i !== index) })}>Remove</button>
        </fieldset>)}
        <button type="button" disabled={scenario.candidates.length >= 12} onClick={() => edit({ ...scenario, candidates: [...scenario.candidates, { name: "", available: false, can_arrive_48h: false, notes: "" }] })}>Add candidate</button>
      </fieldset>
      <fieldset disabled={busy !== null}>
        <legend>4 · Ticket types</legend>
        {scenario.ticket_types.map((ticket, index) => <div className="row" key={index}><label>Ticket type {index + 1}<input required maxLength={200} value={ticket} onChange={e => edit({ ...scenario, ticket_types: scenario.ticket_types.map((item, i) => i === index ? e.target.value : item) })} /></label><button type="button" disabled={scenario.ticket_types.length <= 1} aria-label={`Remove ticket type ${index + 1}`} onClick={() => edit({ ...scenario, ticket_types: scenario.ticket_types.filter((_, i) => i !== index) })}>Remove</button></div>)}
        <button type="button" disabled={scenario.ticket_types.length >= 12} onClick={() => edit({ ...scenario, ticket_types: [...scenario.ticket_types, ""] })}>Add ticket type</button>
      </fieldset>
      <div className="actions">
        <button className="primary" type="submit" disabled={busy !== null}>Rescue with Qloo</button>
        <button type="submit" disabled={busy !== null} onClick={e => { e.preventDefault(); if (e.currentTarget.form?.reportValidity()) void run("baseline"); }}>LLM only (no Qloo)</button>
      </div>
    </form>
    <p role="status" aria-live="polite">{busy ? `Running ${busy === "qloo" ? "Qloo rescue" : "LLM-only comparison"}… Up to 50 seconds.` : Object.keys(results).length ? "Results ready. Run the other mode to compare." : "Ready to compare."}</p>
    {error && <p role="alert" className="error">{error}</p>}
    {results.qloo && results.baseline && <aside className="notice" aria-label="Comparison"><strong>Ranking comparison</strong><p>Qloo: {results.qloo.plans.map(p => p.promoted_act ?? p.replacement).join(" → ") || "No grounded plan"}</p><p>LLM only: {results.baseline.plans.map(p => p.promoted_act ?? p.replacement).join(" → ") || "No suggestion"}</p><p>{results.qloo.plans[0]?.replacement === results.baseline.plans[0]?.replacement ? "The first replacement agrees. Inspect the evidence; agreement alone does not validate the guess." : "The first replacement differs. Qloo uses observed taste evidence; LLM only has no audience measurements."}</p></aside>}
    <div className="comparison">
      {(["qloo", "baseline"] as const).map(mode => results[mode] && <ResultPanel key={results[mode].run_id} result={results[mode]} busy={busy !== null} resolutions={resolutions} choose={(name, id) => setResolutions(previous => ({ ...previous, [name]: id }))} rerun={() => void run(mode)} />)}
    </div>
  </>;
}
function ResultPanel({ result, busy, resolutions, choose, rerun }: { result: RescueResponse; busy: boolean; resolutions: Record<string, string>; choose: (name: string, id: string) => void; rerun: () => void }) {
  return <section className="result" aria-label={result.mode === "qloo" ? "Qloo rescue result" : "LLM-only result"}>
    <h2>{result.mode === "qloo" ? "Qloo rescue" : "LLM only (no Qloo)"}</h2>
    <p>{result.mode === "qloo" ? `Taste source: ${result.data_source}` : "No Qloo lookup or taste data"} · Planner: {result.llm}</p>
    {result.data_source === "mock" && <p className="banner">Sample data</p>}
    <h3>Excluded by hard constraints</h3>
    {result.excluded.length ? <ul>{result.excluded.map(a => <li key={a.name}><strong>{a.name}</strong>: {a.reason}</li>)}</ul> : <p>None.</p>}
    <h3>Needs input</h3>
    {result.needs_input.length ? <div>{result.needs_input.map(a => <label key={a.name}>Choose the catalog match for {a.name}<select disabled={busy} value={resolutions[a.name] ?? ""} onChange={e => choose(a.name, e.target.value)}><option value="">Choose an act…</option>{a.options.map(o => <option value={o.entity_id} key={o.entity_id}>{o.label} · {o.entity_id}</option>)}</select></label>)}<button type="button" disabled={busy || !result.needs_input.some(a => resolutions[a.name])} onClick={rerun}>Re-run with selected matches</button></div> : <p>None.</p>}
    <h3>Not in the Qloo catalog</h3>
    {result.mode === "baseline" ? <p>Not checked in this mode.</p> : result.not_in_catalog.length ? <ul>{result.not_in_catalog.map(n => <li key={n}>{n} — not scored or guessed.</li>)}</ul> : <p>None.</p>}
    <h3>Rebuild plans</h3>
    {!result.plans.length && <p>No supported plan is available. Resolve names or update the phone list.</p>}
    {result.plans.map(p => <article className="plan" key={p.id}><h4>{p.id} · {p.title}</h4><p><strong>{p.type === "direct_swap" ? "Direct replacement" : "Promote and fill"}</strong> · {p.promoted_act ? `${p.promoted_act} moves up; ${p.replacement} fills the freed slot.` : p.replacement}</p><p>{p.rationale}</p><dl><dt>Cancelled act’s audience</dt><dd>{p.evidence.fit_original_audience}</dd><dt>Lineup’s audience</dt><dd>{p.evidence.fit_lineup_audience}</dd><dt>Regional audience</dt><dd>{p.evidence.local_heat}</dd></dl><ul>{p.caveats.map((c, i) => <li key={i}>{c}</li>)}</ul></article>)}
    <h3>Announcement drafts</h3><p>Edit these locally before using your official channels. Nothing is sent by this app.</p>
    <label>Short social post<textarea defaultValue={result.announcement.short_post} rows={5} /></label>
    <label>Email subject<input defaultValue={result.announcement.email_subject} /></label>
    <label>Email to ticket holders<textarea defaultValue={result.announcement.email_body} rows={10} /></label>
    <h3>Refund handling checklist</h3>{result.refund_checklist.map(t => <div key={t.ticket_type}><h4>{t.ticket_type}</h4><ul>{t.items.map((item, i) => <li key={i}>{item}</li>)}</ul></div>)}
    <details><summary>Tool trace ({result.trace.length} calls)</summary><p>Entity IDs are shortened. Counts and latency describe this run’s tool results.</p><ol>{result.trace.map((t, i) => <li key={i}><strong>{t.tool}</strong> · {t.status} · {t.result_count} results · {t.ms} ms<pre>{JSON.stringify(t.params, null, 2)}</pre></li>)}</ol></details>
    <h3>Limits and disclaimers</h3><ul>{result.disclaimers.map((d, i) => <li key={i}>{d}</li>)}</ul>
  </section>;
}
