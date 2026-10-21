import "server-only";

export type UsageLimitReason = "ip_limit" | "daily_cap";
export type ModelReservation = { reason: UsageLimitReason } | { finish: (counted: boolean) => void };
type Counter = { start: number; count: number };
function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export class RunLimiter {
  private ips = new Map<string, Counter>();
  private daily: Counter = { start: -1, count: 0 };
  constructor(private now = Date.now, private perIp = positiveInteger(process.env.LLM_RUNS_PER_IP, 20),
    private perDay = positiveInteger(process.env.LLM_RUNS_PER_DAY, 1_500)) {}

  // Reserve both counters atomically immediately before live model work. Keep
  // successful runs only; fallback/error releases the slot, even across resets.
  reserve(ipHash: string): ModelReservation {
    const now = this.now();
    for (const [ip, item] of this.ips) if (now - item.start >= 600_000) this.ips.delete(ip);
    const day = Math.floor(now / 86_400_000);
    if (day !== this.daily.start) this.daily = { start: day, count: 0 };
    if (this.daily.count >= this.perDay) return { reason: "daily_cap" };
    let item = this.ips.get(ipHash);
    if (!item) {
      if (this.ips.size >= 10_000) return { reason: "ip_limit" };
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
