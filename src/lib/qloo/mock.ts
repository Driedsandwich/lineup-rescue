import "server-only";
import artists from "./fixtures/artists.json";
import type { Qloo } from "./types";

/** Invented demonstration values. Not measurements, percentages or Qloo data. */
export function pseudoAffinity(value: string): number {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return (200 + hash % 751) / 1000;
}
export class MockQloo implements Qloo {
  readonly source = "mock" as const;
  async search(name: string) {
    return artists.filter(a => a.name.toLowerCase() === name.toLowerCase()).map(a => ({ ...a, affinity: null }));
  }
  async rank(options: string[], signals: string[], city: string) {
    if (!signals.length) return [];
    return artists.filter(a => options.includes(a.entity_id)).map(a => ({ ...a, affinity: pseudoAffinity(`${a.entity_id}|${[...signals].sort().join(",")}|${city}`) })).sort((a, b) => b.affinity - a.affinity);
  }
  async heat(id: string, region: string) {
    if (!artists.some(a => a.entity_id === id)) return [];
    return ["central area", "surrounding area"].map(area => ({ label: `${region}: sample ${area}`, affinity: pseudoAffinity(`${id}|${region}|${area}`) }));
  }
}
