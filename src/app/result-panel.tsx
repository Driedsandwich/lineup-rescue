import type { RescueResponse } from "../lib/contracts";
import { comparePlans, evidenceValue } from "../lib/presentation";

type Props = { result: RescueResponse; differences: ReturnType<typeof comparePlans>; busy: boolean; pendingChoices: boolean; resolutions: Record<string, string>; choose: (name: string, id: string) => void; rerun: () => void };

export function EvidenceMeter({ label, text, baseline }: { label: string; text: string; baseline: boolean }) {
  const value = baseline ? null : evidenceValue(text);
  return <div className="evidence-item"><div className="split"><span>{label}</span><strong className="mono">{value === null ? baseline ? "NO DATA" : "UNKNOWN" : value.toFixed(3)}</strong></div>
    {value !== null ? <meter min={0} max={1} value={value} aria-label={`${label}: affinity ${value.toFixed(3)}, not a probability`} /> : <div className="empty-meter" aria-hidden="true" />}
    <small>{baseline ? "No audience evidence. Ungrounded suggestion." : text}</small>
  </div>;
}

export default function ResultPanel({ result, differences, busy, pendingChoices, resolutions, choose, rerun }: Props) {
  const baseline = result.mode === "baseline";
  return <section className={`result ${baseline ? "baseline" : "grounded"}`} aria-label={baseline ? "LLM-only result" : "Qloo rescue result"}>
    <header className="result-heading"><div className="split"><span className="eyebrow">{baseline ? "The control" : "The grounded route"}</span><span className={`chip ${baseline ? "warning" : "good"}`}>{baseline ? "No audience evidence" : result.data_source === "mock" ? "Synthetic evidence" : "Qloo evidence"}</span></div><h3>{baseline ? "LLM-only" : "Rescue with Qloo"}</h3><p>{baseline ? "Same inputs. Qloo tools removed." : "Feasibility first. Audience fit next."}</p><small className="mono">{baseline ? "Catalog not checked" : `Taste source / ${result.data_source}`} · Planner / {result.llm}</small></header>
    <div className="result-context">
    {!baseline && result.data_source === "mock" && <p className="sample-label">Sample data · invented affinities, not live measurements.</p>}
    {pendingChoices && <p className="notice">Selections changed. These plans belong to the previous run. Re-run to apply your choices before comparing.</p>}
    {!!result.needs_input.length && <div className="attention"><span className="chip warning">Needs input</span><h4>Which act do you mean?</h4><p>Choose a catalog match for each name. Unresolved acts are not scored.</p>
      {result.needs_input.map(act => <fieldset disabled={busy} className="resolution" key={act.name}><legend>{act.name}</legend>{act.options.map(option => <label className="choice" key={option.entity_id}><input type="radio" name={`resolution-${act.name}`} value={option.entity_id} checked={resolutions[act.name] === option.entity_id} onChange={() => choose(act.name, option.entity_id)} /><span>{option.label}<small className="mono">{option.entity_id}</small></span></label>)}</fieldset>)}
      <button type="button" disabled={busy || !result.needs_input.every(act => resolutions[act.name])} onClick={rerun}>Apply choices & re-run</button>
    </div>}
    {!baseline && !!result.not_in_catalog.length && <div className="attention"><span className="chip neutral">Not in catalog</span>{result.not_in_catalog.map(name => <p key={name}><strong>{name}</strong> — Qloo does not know this act yet; it was not scored.</p>)}</div>}
    {!!result.excluded.length && <details className="exclusions"><summary><span className="chip danger">Excluded · {result.excluded.length}</span> Hard constraints</summary><ul>{result.excluded.map(act => <li key={act.name}><strong>{act.name}</strong><br />{act.reason}</li>)}</ul></details>}
    </div>
    <div className="plan-stack">
      {!result.plans.length && <p className="notice">No supported plan. Resolve the names above or update the phone list.</p>}
      {result.plans.map((plan, index) => {
        const diff = differences[index];
        return <article className={`plan ${diff && diff.status !== "same" ? "differs" : ""}`} key={plan.id}>
          <div className="split"><span className="plan-number mono">PLAN {String(index + 1).padStart(2, "0")}</span><span className="chip neutral">{plan.type === "direct_swap" ? "Direct swap" : "Promote + fill"}</span></div>
          {diff && <p className={`diff-label ${diff.status === "same" ? "agrees" : ""}`}>{diff.status === "same" ? "Same choice · evidence still matters" : diff.status === "missing" ? "No counterpart at this position" : "Different choice at this position"}</p>}
          <h4>{plan.promoted_act ?? plan.replacement}</h4>{plan.promoted_act && <p className="fill-slot">Moves to the cancelled slot. <strong>{plan.replacement}</strong> fills the freed slot.</p>}
          <p className="rationale">{plan.rationale}</p>
          <div className="evidence"><EvidenceMeter label="Cancelled act’s audience" text={plan.evidence.fit_original_audience} baseline={baseline} /><EvidenceMeter label="Remaining lineup" text={plan.evidence.fit_lineup_audience} baseline={baseline} /><EvidenceMeter label="Local heat" text={plan.evidence.local_heat} baseline={baseline} /></div>
          {!baseline && <p className="meter-note">Affinity, not probability. For multiple values, the meter shows the first; all observed values appear above. Different signals are not calibrated against one another.</p>}
          <details className="plan-checks"><summary>Before you commit</summary><ul>{plan.caveats.map((caveat, i) => <li key={i}>{caveat}</li>)}</ul></details>
        </article>;
      })}
      {differences.slice(result.plans.length).map(row => <article className="plan missing-plan" key={row.position}><span className="plan-number mono">PLAN {String(row.position).padStart(2, "0")}</span><h4>No plan returned</h4><p>The other run returned an option at this position.</p></article>)}
    </div>
    <details className="output-drawer"><summary>Announcement drafts <span className="chip neutral">Editable</span></summary><p>Review before using your official channels. Nothing is sent.</p><label>Short social post<textarea defaultValue={result.announcement.short_post} rows={5} /></label><label>Email subject<input defaultValue={result.announcement.email_subject} /></label><label>Email to ticket holders<textarea defaultValue={result.announcement.email_body} rows={10} /></label></details>
    <details className="output-drawer"><summary>Refund handling checklist</summary><p>Verify the terms. This app does not set a refund policy.</p>{result.refund_checklist.map(ticket => <div key={ticket.ticket_type}><h4>{ticket.ticket_type}</h4><ul className="checklist">{ticket.items.map((item, i) => <li key={i}><label><input type="checkbox" />{item}</label></li>)}</ul></div>)}</details>
    <details className="output-drawer trace"><summary>Tool trace <span className="mono">{result.trace.length} entries</span></summary><p>Model time, redacted tool parameters and result counts. Entity IDs are shortened. Server-initiated calls are labelled.</p><ol>{result.trace.map((entry, i) => <li key={i}><div className="split"><strong>{entry.tool === "model_turn" ? `Model turn ${entry.params.turn}` : entry.tool}{entry.params.by === "server" ? " (server)" : ""}</strong><span className="chip neutral">{entry.status}</span></div><small className="mono">{entry.result_count} {entry.tool === "model_turn" ? "tool calls requested" : "results"} / {entry.ms} ms</small><pre>{JSON.stringify(entry.params, null, 2)}</pre></li>)}</ol></details>
    <details className="output-drawer"><summary>Limits & provenance</summary><ul>{result.disclaimers.map((disclaimer, i) => <li key={i}>{disclaimer}</li>)}</ul></details>
  </section>;
}
