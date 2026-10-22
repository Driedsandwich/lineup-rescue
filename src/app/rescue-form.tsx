"use client";

import { useEffect, useRef, useState } from "react";
import type { RescueResponse, Scenario } from "../lib/contracts";
import { filterCandidates } from "../lib/agent/constraints";
import { comparePlans, runningOrder, sampleForMode, type ProviderStatus } from "../lib/presentation";
import { requestRescue } from "../lib/rescue-client";
import ScenarioEditor from "./scenario-editor";
import ResultPanel from "./result-panel";

type Mode = "qloo" | "baseline";
const stages = ["Filtering the phone list", "Resolving act names", "Ranking against both audiences", "Checking local heat", "Drafting plans and announcements"];

export default function RescueForm({ initialStatus }: { initialStatus: ProviderStatus }) {
  const [status, setStatus] = useState(initialStatus);
  const [scenario, setScenario] = useState<Scenario>(() => sampleForMode(initialStatus.qloo));
  const [results, setResults] = useState<Partial<Record<Mode, RescueResponse>>>({});
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const [pendingChoices, setPendingChoices] = useState(false);
  const [busy, setBusy] = useState<Mode | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState(false);
  const lock = useRef(false);
  const edited = useRef(false);
  const resultAnchor = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/status", { cache: "no-store", signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("Status unavailable");
      const next: ProviderStatus = await response.json();
      if (!["live", "mock"].includes(next.qloo) || !["live", "mock"].includes(next.llm)) throw new Error("Invalid status");
      setStatus(next);
      if (next.qloo !== initialStatus.qloo && !edited.current && !lock.current) {
        setScenario(sampleForMode(next.qloo)); setResults({}); setResolutions({}); setPendingChoices(false);
      }
    }).catch(() => { if (!controller.signal.aborted) setStatusError(true); });
    return () => controller.abort();
  }, [initialStatus.qloo]);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setProgress(previous => Math.min(previous + 1, stages.length - 1)), 1800);
    return () => clearInterval(timer);
  }, [busy]);

  function edit(next: Scenario) {
    edited.current = true; setScenario(next); setResults({}); setResolutions({}); setPendingChoices(false); setError("");
  }
  function choose(name: string, id: string) {
    setResolutions(previous => ({ ...previous, [name]: id }));
    setPendingChoices(true); setResults(previous => ({ qloo: previous.qloo }));
  }
  async function run(mode: Mode) {
    if (lock.current) return;
    lock.current = true; setBusy(mode === "qloo" || !results.qloo || pendingChoices ? "qloo" : "baseline"); setProgress(0); setError("");
    // Both requests use this exact snapshot. Editing is disabled until both finish.
    const input = structuredClone(scenario);
    const choices = { ...resolutions };
    try {
      if (mode === "qloo" || !results.qloo || pendingChoices) {
        const qloo = await requestRescue("qloo", input, choices);
        setResults(previous => ({ ...previous, qloo })); setPendingChoices(false);
      }
      if (mode === "baseline") {
        setBusy("baseline"); setProgress(0);
        const baseline = await requestRescue("baseline", input, choices);
        setResults(previous => ({ ...previous, baseline }));
      }
      resultAnchor.current?.focus({ preventScroll: true });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The run failed. Retry in a moment."); }
    finally { lock.current = false; setBusy(null); }
  }
  const filtered = filterCandidates(scenario.candidates);
  const differences = results.qloo && results.baseline && !pendingChoices ? comparePlans(results.qloo.plans, results.baseline.plans) : [];
  return <>
    <section className="hero" aria-labelledby="hero-title">
      <div><p className="eyebrow"><span className="signal-dot" /> Cancellation response / {scenario.festival_name}</p><h1 id="hero-title">Keep the night{" "}<br /><em>on the bill.</em></h1><p className="hero-copy">One empty slot. A phone list you can actually book.{" "}<br />Find the audience fit, then rebuild the running order.</p></div>
      <aside className="incident"><div className="split"><span className="eyebrow">Open slot</span><span className="chip danger">Cancelled</span></div><h2>{scenario.cancelled_act.name}</h2><p className="mono">{scenario.cancelled_act.slot}</p><div className="incident-footer"><span>{scenario.city}</span><span>{scenario.date}</span></div></aside>
    </section>
    <div className="source-bar"><div><span className={`chip ${status.qloo === "mock" ? "warning" : "good"}`}>{status.qloo === "mock" ? "Sample data" : "Live Qloo"}</span><span>{status.qloo === "mock" ? "Fictional acts · synthetic affinity" : "Real artist names · fictional festival and logistics"}</span></div><span className="mono">Planner / {status.llm === "mock" ? "deterministic sample" : "live LLM"}</span></div>
    {statusError && <p className="notice">Status refresh unavailable. Showing the server’s initial mode; each result reports its actual source.</p>}
    {status.qloo === "live" && <p className="notice">Fictional scenario for demonstration. Artist names are used only to look up public taste data; no real cancellation or booking is implied.</p>}
    <section className="operations" aria-labelledby="order-title">
      <div className="section-heading"><div><p className="eyebrow">01 / The situation</p><h2 id="order-title">Tonight’s running order</h2></div><a href="#scenario-editor" onClick={() => document.getElementById("scenario-editor")?.setAttribute("open", "")}>Edit scenario <span aria-hidden="true">↗</span></a></div>
      <div className="timeline-grid">{runningOrder(scenario).map(group => <div className="stage" key={group.stage}><h3><span className="stage-light" />{group.stage}<span className="mono">STAGE</span></h3><ol className="timeline">{group.acts.map((act, index) => <li className={act.cancelled ? "cancelled" : ""} key={index}><span className="mono slot-time">{act.slot}</span><div>{act.cancelled ? <del>{act.name}</del> : <strong>{act.name}</strong>}{act.cancelled && <span className="chip danger">Slot to rebuild</span>}</div></li>)}</ol></div>)}</div>
    </section>
    <form onSubmit={event => { event.preventDefault(); void run("qloo"); }} onInvalid={event => { (event.target as HTMLElement).closest("details")?.setAttribute("open", ""); }} aria-describedby="privacy">
      <section className="operations" aria-labelledby="phone-title"><div className="section-heading"><div><p className="eyebrow">02 / Feasibility first</p><h2 id="phone-title">The booker’s phone list</h2></div><span className="chip neutral">{filtered.eligible.length} eligible / {scenario.candidates.length} acts</span></div>
        <div className="phone-grid">{scenario.candidates.map((act, i) => {
          const excluded = filtered.excluded.find(item => item.name === act.name);
          return <article className={`phone-card ${excluded ? "is-excluded" : ""}`} key={i}><div className="split"><span className="mono index">{String(i + 1).padStart(2, "0")}</span><span className={`chip ${excluded ? "danger" : "good"}`}>{excluded ? "Excluded" : "Eligible"}</span></div><h3>{act.name || "Unnamed act"}</h3><p>{excluded?.reason || `Available · crew + gear within 48 h${act.travel_hours !== undefined ? ` · ${act.travel_hours} h travel` : " · travel time unrecorded"}`}</p><p className="booker-note">{act.notes}</p></article>;
        })}</div>
        <ScenarioEditor scenario={scenario} edit={edit} busy={busy !== null} />
      </section>
      <div className="run-console"><div><span className="eyebrow">03 / Rebuild the night</span><p>Two audiences. One feasible shortlist.</p><small>Also tests promoting an act already on the bill.</small></div><div className="actions"><button className="primary" type="submit" disabled={busy !== null}>Rescue with Qloo <span aria-hidden="true">↗</span></button><button type="submit" disabled={busy !== null} onClick={event => { event.preventDefault(); if (event.currentTarget.form?.reportValidity()) void run("baseline"); }}>Compare with LLM-only</button></div></div>
      <p id="privacy" className="privacy">Public act names only. No personal data. Notes go to the live language model, never to Qloo. Nothing is booked, sent or published.</p>
    </form>
    <div className={`progress ${busy ? "is-running" : ""}`} role="status" aria-live="polite" aria-atomic="true"><span className="signal-dot" /><span>{busy ? `${busy === "baseline" ? progress === 0 ? "LLM-only · Filtering the phone list" : "LLM-only · Drafting without audience evidence" : stages[progress]}… Up to 50 seconds per run.` : error ? "Run stopped. Your inputs are preserved." : results.qloo ? "Plans ready for review. No replacement is confirmed." : "Ready when you are."}</span>{busy && <small>Progress is a time-based guide, not a server trace. A comparison can take two runs.</small>}</div>
    {error && <div role="alert" className="error"><strong>Could not complete the run</strong><p>{error}</p></div>}
    <section aria-labelledby="results-title" aria-busy={busy !== null}>
      <div className="section-heading"><div><p className="eyebrow">04 / Decision desk</p><h2 id="results-title" ref={resultAnchor} tabIndex={-1}>{results.baseline ? "Evidence beside the guess" : "Your rebuild options"}</h2></div>{results.qloo && !results.baseline && <span className="chip neutral">Compare to inspect the difference</span>}</div>
      {!results.qloo && <div className="empty-state"><span className="empty-number" aria-hidden="true">—</span><h3>The slot is open. Start with the evidence.</h3><p>Run a rescue to see direct swaps, a promotion path and editable response drafts.</p></div>}
      {!!differences.length && <aside className="comparison-summary" aria-label="Plan comparison"><strong>{differences.filter(row => row.status !== "same").length} of {differences.length} plan positions differ or lack a counterpart</strong><p>Compared in returned order, including both the promoted act and the fill. Agreement does not validate an ungrounded suggestion.</p></aside>}
      <div className={`comparison ${results.baseline ? "two-up" : ""}`}>{(["qloo", "baseline"] as const).map(mode => results[mode] && <ResultPanel key={results[mode].run_id} result={results[mode]} cancelledActName={scenario.cancelled_act.name} differences={differences} busy={busy !== null} pendingChoices={mode === "qloo" && pendingChoices} resolutions={resolutions} choose={choose} rerun={() => void run("qloo")} />)}</div>
    </section>
  </>;
}
