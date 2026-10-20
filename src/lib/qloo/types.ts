export type Params = Record<string, string | number | readonly string[] | undefined>;
export type Entity = { entity_id: string; name: string; affinity: number | null };
export type Heat = { label: string; affinity: number | null };
export interface Qloo {
  source: "live" | "mock";
  search(name: string, signal?: AbortSignal): Promise<Entity[]>;
  rank(options: string[], signals: string[], city: string, signal?: AbortSignal): Promise<Entity[]>;
  heat(id: string, region: string, signal?: AbortSignal): Promise<Heat[]>;
}
