import type { Entity, Heat, Params } from "./types";

export function serialize(params: Params): string {
  const query = new URLSearchParams();
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (value !== undefined) query.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  return query.toString();
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}
export function resultItems(body: unknown): unknown[] {
  const results = record(body).results;
  if (Array.isArray(results)) return results;
  const wrapped = record(results);
  for (const key of ["entities", "heatmap", "tags"]) if (Array.isArray(wrapped[key])) return wrapped[key] as unknown[];
  return [];
}
function affinity(item: Record<string, unknown>): number | null {
  for (const value of [item.affinity, record(item.query).affinity]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}
export function parseEntities(body: unknown): Entity[] {
  return resultItems(body).flatMap(raw => {
    const item = record(raw);
    const id = item.entity_id ?? item.id;
    return typeof id === "string" && typeof item.name === "string"
      ? [{ entity_id: id.slice(0, 200), name: item.name.slice(0, 200), affinity: affinity(item) }] : [];
  });
}
export function parseHeat(body: unknown): Heat[] {
  return resultItems(body).map(raw => {
    const item = record(raw);
    const location = record(item.location);
    const label = [location.name, item.name].find(value => typeof value === "string" && value.trim());
    return { label: typeof label === "string" ? label.slice(0, 200) : "", affinity: affinity(item) };
  }).sort((a, b) => (b.affinity ?? -Infinity) - (a.affinity ?? -Infinity));
}
