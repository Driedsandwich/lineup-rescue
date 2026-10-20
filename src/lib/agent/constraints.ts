import type { Scenario } from "../contracts";

export function filterCandidates(candidates: Scenario["candidates"]) {
  const eligible: Scenario["candidates"] = [];
  const excluded: { name: string; reason: string }[] = [];
  for (const candidate of candidates) {
    const reasons = [];
    if (!candidate.available) reasons.push("Not available");
    if (!candidate.can_arrive_48h) reasons.push("Cannot arrive within 48 hours with crew and gear");
    if (candidate.travel_hours !== undefined && candidate.travel_hours > 48) reasons.push("Travel exceeds 48 hours");
    if (reasons.length) excluded.push({ name: candidate.name, reason: reasons.join("; ") });
    else eligible.push(candidate);
  }
  return { eligible, excluded };
}
