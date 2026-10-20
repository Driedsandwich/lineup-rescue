import "server-only";

export class RunLimiter {
  private ips = new Map<string, { start: number; count: number }>();
  private day = "";
  private daily = 0;
  constructor(private now = Date.now) {}
  checkIp(ipHash: string): boolean {
    const now = this.now();
    for (const [ip, item] of this.ips) if (now - item.start >= 600_000) this.ips.delete(ip);
    let item = this.ips.get(ipHash);
    if (!item) {
      if (this.ips.size >= 10_000) return false;
      item = { start: now, count: 0 };
      this.ips.set(ipHash, item);
    }
    if (item.count >= 5) return false;
    item.count++;
    return true;
  }
  takeDaily(): boolean {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (day !== this.day) { this.day = day; this.daily = 0; }
    if (this.daily >= 300) return false;
    this.daily++;
    return true;
  }
}
