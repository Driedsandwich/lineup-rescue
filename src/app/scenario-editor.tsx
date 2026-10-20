import type { Scenario } from "../lib/contracts";

export default function ScenarioEditor({ scenario, edit, busy }: { scenario: Scenario; edit: (next: Scenario) => void; busy: boolean }) {
  return <details className="scenario-editor" id="scenario-editor"><summary>Edit scenario & phone list <span className="summary-note">Festival, lineup, logistics, tickets</span></summary>
    <p>Changes clear previous results so both runs always use the same inputs. Availability is your input, not a prediction.</p>
    <fieldset disabled={busy}><legend>Festival & cancellation</legend><div className="fields">
      <label>Festival name<input required maxLength={200} value={scenario.festival_name} onChange={e => edit({ ...scenario, festival_name: e.target.value })} /></label>
      <label>City<input required maxLength={200} value={scenario.city} onChange={e => edit({ ...scenario, city: e.target.value })} /></label>
      <label>Date<input required type="date" value={scenario.date} onChange={e => edit({ ...scenario, date: e.target.value })} /></label>
      <label>Cancelled act<input required maxLength={200} value={scenario.cancelled_act.name} onChange={e => edit({ ...scenario, cancelled_act: { ...scenario.cancelled_act, name: e.target.value } })} /></label>
      <label>Cancelled stage & time<input required maxLength={200} value={scenario.cancelled_act.slot} onChange={e => edit({ ...scenario, cancelled_act: { ...scenario.cancelled_act, slot: e.target.value } })} /></label>
    </div></fieldset>
    <fieldset disabled={busy}><legend>Remaining lineup ({scenario.lineup.length}/20)</legend>
      {scenario.lineup.map((act, index) => <div className="editor-row" key={index}>
        {(["name", "stage", "slot"] as const).map(field => <label key={field}>{field === "name" ? "Act name" : field === "stage" ? "Stage" : "Time slot"}<input required maxLength={200} value={act[field]} onChange={e => edit({ ...scenario, lineup: scenario.lineup.map((item, i) => i === index ? { ...item, [field]: e.target.value } : item) })} /></label>)}
        <button type="button" aria-label={`Remove lineup act ${index + 1}`} onClick={() => edit({ ...scenario, lineup: scenario.lineup.filter((_, i) => i !== index) })}>Remove</button>
      </div>)}
      <button type="button" disabled={scenario.lineup.length >= 20} onClick={() => edit({ ...scenario, lineup: [...scenario.lineup, { name: "", stage: "", slot: "" }] })}>Add lineup act</button>
    </fieldset>
    <fieldset disabled={busy}><legend>Phone list ({scenario.candidates.length}/12)</legend>
      <p>Confirm availability and arrival with crew and gear. Travel over 48 hours excludes an act.</p>
      {scenario.candidates.map((candidate, index) => <fieldset className="candidate" key={index}><legend>Candidate {index + 1}</legend><div className="fields">
        <label>Act name<input required maxLength={200} value={candidate.name} onChange={e => edit({ ...scenario, candidates: scenario.candidates.map((item, i) => i === index ? { ...item, name: e.target.value } : item) })} /></label>
        <label>Travel time (hours, optional)<input type="number" min={0} max={1000} step="any" value={candidate.travel_hours ?? ""} onChange={e => edit({ ...scenario, candidates: scenario.candidates.map((item, i) => i === index ? { ...item, travel_hours: e.target.value === "" ? undefined : Number(e.target.value) } : item) })} /></label>
        <label className="check"><input type="checkbox" checked={candidate.available} onChange={e => edit({ ...scenario, candidates: scenario.candidates.map((item, i) => i === index ? { ...item, available: e.target.checked } : item) })} />Available</label>
        <label className="check"><input type="checkbox" checked={candidate.can_arrive_48h} onChange={e => edit({ ...scenario, candidates: scenario.candidates.map((item, i) => i === index ? { ...item, can_arrive_48h: e.target.checked } : item) })} />Crew + gear can arrive within 48 h</label>
        <label className="wide">Booker notes (200 characters maximum)<textarea maxLength={200} value={candidate.notes} onChange={e => edit({ ...scenario, candidates: scenario.candidates.map((item, i) => i === index ? { ...item, notes: e.target.value } : item) })} /></label>
      </div><button type="button" aria-label={`Remove candidate ${index + 1}`} onClick={() => edit({ ...scenario, candidates: scenario.candidates.filter((_, i) => i !== index) })}>Remove</button></fieldset>)}
      <button type="button" disabled={scenario.candidates.length >= 12} onClick={() => edit({ ...scenario, candidates: [...scenario.candidates, { name: "", available: false, can_arrive_48h: false, notes: "" }] })}>Add candidate</button>
    </fieldset>
    <fieldset disabled={busy}><legend>Ticket types</legend>
      {scenario.ticket_types.map((ticket, index) => <div className="editor-row" key={index}><label>Ticket type {index + 1}<input required maxLength={200} value={ticket} onChange={e => edit({ ...scenario, ticket_types: scenario.ticket_types.map((item, i) => i === index ? e.target.value : item) })} /></label><button type="button" disabled={scenario.ticket_types.length <= 1} aria-label={`Remove ticket type ${index + 1}`} onClick={() => edit({ ...scenario, ticket_types: scenario.ticket_types.filter((_, i) => i !== index) })}>Remove</button></div>)}
      <button type="button" disabled={scenario.ticket_types.length >= 12} onClick={() => edit({ ...scenario, ticket_types: [...scenario.ticket_types, ""] })}>Add ticket type</button>
    </fieldset>
  </details>;
}
