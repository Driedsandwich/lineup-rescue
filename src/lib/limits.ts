import "server-only";

export type UsageLimitReason = "ip_limit" | "daily_cap";
export type QlooLimitReason = "client" | "daily_budget";
export type ModelReservation = { reason: UsageLimitReason } | { finish: (counted: boolean) => void };
type Counter = { start: number; count: number };
const MAX_KEYS = 10_000;
function evictOldest<T>(table: Map<string, T>) {
  if (table.size >= MAX_KEYS) table.delete(table.keys().next().value!);
}
export function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export class RunLimiter {
  private ips = new Map<string, Counter>();
  private daily: Counter = { start: -1, count: 0 };
  constructor(private now = Date.now, private perIp = positiveInteger(process.env.LLM_RUNS_PER_IP, 20),
    private perDay = positiveInteger(process.env.LLM_RUNS_PER_DAY, 1_500)) {}

  // Reserve both counters atomically immediately before live model work. Keep
  // every run that sent a model request, including fallback/error/abort. Release
  // only if nothing was sent; captured buckets keep releases safe across resets.
  reserve(ipHash: string): ModelReservation {
    const now = this.now();
    for (const [ip, item] of this.ips) if (now - item.start >= 600_000) this.ips.delete(ip);
    const day = Math.floor(now / 86_400_000);
    if (day !== this.daily.start) this.daily = { start: day, count: 0 };
    if (this.daily.count >= this.perDay) return { reason: "daily_cap" };
    let item = this.ips.get(ipHash);
    if (!item) {
      evictOldest(this.ips);
      item = { start: now, count: 0 };
      this.ips.set(ipHash, item);
    }
    if (item.count >= this.perIp) return { reason: "ip_limit" };
    item.count++;
    const daily = this.daily;
    daily.count++;
    let finished = false;
    return { finish: counted => {
      if (finished) return;
      finished = true;
      if (!counted) { item.count--; daily.count--; }
    } };
  }
}

export class QlooRunLimiter {
  private ips = new Map<string, { window: Counter; daily: Counter }>();
  constructor(private now = Date.now, private perIp = positiveInteger(process.env.QLOO_RUNS_PER_IP, 10),
    private perIpDay = positiveInteger(process.env.QLOO_RUNS_PER_IP_DAY, 40)) {}

  // Count once before live Qloo work, including failed or cancelled runs. Neither
  // result-cache hits nor shared requests nor mock Qloo work reach this check.
  reserve(ipHash: string): boolean {
    const now = this.now();
    const day = Math.floor(now / 86_400_000);
    let item = this.ips.get(ipHash);
    if (!item) {
      evictOldest(this.ips);
      item = { window: { start: now, count: 0 }, daily: { start: day, count: 0 } };
      this.ips.set(ipHash, item);
    }
    if (now - item.window.start >= 600_000) item.window = { start: now, count: 0 };
    if (item.daily.start !== day) item.daily = { start: day, count: 0 };
    if (item.window.count >= this.perIp || item.daily.count >= this.perIpDay) return false;
    item.window.count++;
    item.daily.count++;
    return true;
  }
}
