import sample from "../../samples/scenario.json";
import liveSample from "../../samples/scenario.live.json";
import type { Plan, RescueRequest, Scenario } from "./contracts";

export type ProviderStatus = { qloo: "live" | "mock"; llm: "live" | "mock" };
export function sampleForMode(mode: ProviderStatus["qloo"]): Scenario {
  return structuredClone(mode === "live" ? liveSample : sample);
}

/** Compare ordered plan positions, including both roles in a promotion. IDs are labels only. */
export function comparePlans(qloo: Plan[], baseline: Plan[]) {
  return Array.from({ length: Math.max(qloo.length, baseline.length) }, (_, index) => {
    const grounded = qloo[index];
    const guess = baseline[index];
    return { position: index + 1, qloo: grounded, baseline: guess,
      status: !grounded || !guess ? "missing" as const
        : grounded.type !== guess.type || grounded.replacement !== guess.replacement || grounded.promoted_act !== guess.promoted_act
          ? "different" as const : "same" as const };
  });
}

export function rescuePayload(mode: RescueRequest["mode"], scenario: Scenario, resolutions: Record<string, string>): RescueRequest {
  return { mode, scenario, resolutions: Object.fromEntries(Object.entries(resolutions).filter(([, id]) => id.length > 0)) };
}

export function recoveryAdvice(status: number, retryAfter: string | null, code?: string): string {
  if (status === 400) return "Review the field details in this message, then retry with valid values and unique public act names.";
  if (status === 413) return "Shorten notes or remove extra acts, then retry. The request limit is 64 KiB.";
  if (status === 429) {
    if (code === "daily_cap") return "The daily run cap is reached. Try again after 00:00 UTC.";
    const seconds = Number(retryAfter);
    return `Wait ${Number.isFinite(seconds) && seconds > 0 ? `${Math.ceil(seconds / 60)} minute(s)` : "10 minutes"} before retrying. Repeated clicks will not help.`;
  }
  if (status >= 500) return "Retry once in a moment. If it persists, ask the operator to check provider access; a smaller phone list may help with timeouts.";
  return "Check your connection and retry. Your scenario is still here.";
}

/** Evidence remains text-owned by the server; only a present, bounded affinity gets a meter. */
export function evidenceValue(text: string): number | null {
  const match = text.match(/(?:Qloo affinity|Synthetic pseudo-affinity) (-?\d+(?:\.\d+)?)/);
  if (!match) return null;
  const value = Number(match[1]);
  return value >= 0 && value <= 1 ? value : null;
}

export function runningOrder(scenario: Scenario) {
  const cancelled = scenario.cancelled_act.slot.match(/^(.*?)\s+(\d{1,2}:\d{2}.*)$/);
  const acts = [
    ...scenario.lineup.map(act => ({ ...act, cancelled: false })),
    { name: scenario.cancelled_act.name, stage: cancelled?.[1].replace(/\s+stage$/i, "") || "Cancelled slot", slot: cancelled?.[2] || scenario.cancelled_act.slot, cancelled: true },
  ];
  return [...new Set(acts.map(act => act.stage))].map(stage => ({ stage, acts: acts.filter(act => act.stage === stage).sort((a, b) => a.slot.localeCompare(b.slot, "en", { numeric: true })) }));
}
