import "server-only";
import { positiveInteger } from "../limits";

type Waiting = { start: () => void; abort: () => void };

/** Shared by all live clients in one server instance, including concurrent runs. */
export class QlooRequests {
  private starts: number[] = [];
  private active = 0;
  private queue: Waiting[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private daily = { day: -1, count: 0 };

  constructor(private maxPerSecond = positiveInteger(process.env.QLOO_MAX_PER_SECOND, 8),
    private callsPerDay = positiveInteger(process.env.QLOO_CALLS_PER_DAY, 2_000),
    private now = Date.now, private gateNow = () => performance.now()) {}

  private today() {
    const day = Math.floor(this.now() / 86_400_000);
    if (this.daily.day !== day) this.daily = { day, count: 0 };
    return this.daily;
  }
  // Admission only: an admitted run may finish after crossing the daily budget.
  canStartRun() { return this.today().count < this.callsPerDay; }
  recordSent() { this.today().count++; }

  run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const job: Waiting = {
        abort: () => {
          this.queue = this.queue.filter(item => item !== job);
          reject(signal?.reason);
          this.pump();
        },
        start: () => {
          signal?.removeEventListener("abort", job.abort);
          this.active++;
          this.starts.push(this.gateNow());
          // Start synchronously so a slot means an actual transport invocation.
          let pending: Promise<T>;
          try { pending = work(); } catch (error) { pending = Promise.reject(error); }
          void pending.then(resolve, reject).finally(() => { this.active--; this.pump(); });
        },
      };
      signal?.addEventListener("abort", job.abort, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }

  private pump() {
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
    const now = this.gateNow();
    this.starts = this.starts.filter(start => now - start < 1_000);
    while (this.queue.length && this.active < this.maxPerSecond && this.starts.length < this.maxPerSecond) {
      this.queue.shift()!.start();
    }
    if (this.queue.length && this.active < this.maxPerSecond) {
      this.timer = setTimeout(() => { this.timer = undefined; this.pump(); }, Math.max(1, this.starts[0] + 1_000 - now));
    }
  }
}

export const qlooRequests = new QlooRequests();
