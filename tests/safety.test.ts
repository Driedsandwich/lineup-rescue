import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { RunLimiter } from "../src/lib/limits";
import { requestSchema } from "../src/lib/contracts";
import sample from "../samples/scenario.json";

describe("fixture and server boundary guards", () => {
  it("documents all four Qloo limit settings in the environment example without exposing its contents", () => {
    const settings = new Set([...readFileSync(".env.example", "utf8").matchAll(/^#\s*(QLOO_[A-Z_]+)=/gm)].map(match => match[1]));
    for (const name of ["QLOO_RUNS_PER_IP", "QLOO_RUNS_PER_IP_DAY", "QLOO_MAX_PER_SECOND", "QLOO_CALLS_PER_DAY"]) {
      expect(settings.has(name), name).toBe(true);
    }
  });
  it("fails on any UUID-shaped string in any fixture file, recursively", () => {
    function inspect(path: string) {
      for (const item of readdirSync(path, { withFileTypes: true })) {
        const file = join(path, item.name);
        if (item.isDirectory()) inspect(file);
        else expect(readFileSync(file, "utf8"), file).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      }
    }
    inspect("src/lib/qloo/fixtures");
  });
  it("Qloo entry points import server-only and the actual browser condition rejects them", () => {
    for (const file of ["client.ts", "index.ts", "mock.ts"]) expect(readFileSync(`src/lib/qloo/${file}`, "utf8")).toMatch(/^import "server-only";/);
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", 'import "./src/lib/qloo/client.ts"'], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cannot be imported from a Client Component");
  });
  it("client import graph cannot reach Qloo transport, server code or credentials", () => {
    const seen = new Set<string>();
    function walk(file: string) {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/X-Api-Key|QLOO_API_KEY|ANTHROPIC_API_KEY|import "server-only"/);
      const imports = source.matchAll(/import\s+(?!type\b)[\s\S]*?from\s+["'](\.[^"']+)["']/g);
      for (const match of imports) {
        const base = resolve(dirname(file), match[1]);
        const next = [base, `${base}.ts`, `${base}.tsx`, `${base}.json`].find(path => {
          try { readFileSync(path); return true; } catch { return false; }
        });
        if (next) walk(next);
      }
    }
    walk(resolve("src/app/rescue-form.tsx"));
  });
});
describe("abuse limits", () => {
  function count(limiter: RunLimiter, ip: string) {
    const reservation = limiter.reserve(ip);
    if ("reason" in reservation) return reservation.reason;
    reservation.finish(true);
    return "live";
  }
  it("allows 20 live runs per IP, isolates IPs and resets after ten minutes", () => {
    let now = 0;
    const limiter = new RunLimiter(() => now);
    for (let i = 0; i < 20; i++) expect(count(limiter, "synthetic-ip")).toBe("live");
    expect(count(limiter, "synthetic-ip")).toBe("ip_limit");
    expect(count(limiter, "other-ip")).toBe("live");
    now = 600_000;
    expect(count(limiter, "synthetic-ip")).toBe("live");
  });
  it("caps global live runs at 1,500 per UTC day", () => {
    let now = 0;
    const limiter = new RunLimiter(() => now);
    for (let i = 0; i < 1_500; i++) expect(count(limiter, `ip-${i}`)).toBe("live");
    expect(count(limiter, "another-ip")).toBe("daily_cap");
    now = 86_400_000;
    expect(count(limiter, "another-ip")).toBe("live");
  });
  it("uses positive integer environment overrides, falling back to defaults for invalid values", () => {
    vi.stubEnv("LLM_RUNS_PER_IP", "2");
    vi.stubEnv("LLM_RUNS_PER_DAY", "3");
    const limiter = new RunLimiter();
    expect(count(limiter, "a")).toBe("live");
    expect(count(limiter, "a")).toBe("live");
    expect(count(limiter, "a")).toBe("ip_limit");
    expect(count(limiter, "b")).toBe("live");
    expect(count(limiter, "c")).toBe("daily_cap");
    for (const value of ["", "0", "-1", "1.5", "no", "Infinity", "9007199254740992"]) {
      vi.stubEnv("LLM_RUNS_PER_IP", value);
      vi.stubEnv("LLM_RUNS_PER_DAY", value);
      const defaults = new RunLimiter();
      for (let i = 0; i < 20; i++) expect(count(defaults, "a")).toBe("live");
      expect(count(defaults, "a")).toBe("ip_limit");
      for (let i = 20; i < 1_500; i++) expect(count(defaults, `ip-${i}`)).toBe("live");
      expect(count(defaults, "b")).toBe("daily_cap");
    }
  });
  it("reserves atomically and releases fallbacks exactly once without touching reset buckets", () => {
    let now = 0;
    const limiter = new RunLimiter(() => now, 1, 2);
    const first = limiter.reserve("a");
    if (!("finish" in first)) throw new Error("Expected reservation");
    expect(count(limiter, "a")).toBe("ip_limit");
    expect(count(limiter, "b")).toBe("live"); // denied IP attempt did not consume daily quota
    first.finish(false);
    first.finish(false);
    const retry = limiter.reserve("a");
    if (!("finish" in retry)) throw new Error("Expected reservation");
    now = 86_400_000;
    expect(count(limiter, "a")).toBe("live");
    retry.finish(false);
    expect(count(limiter, "a")).toBe("ip_limit");
    expect(count(limiter, "b")).toBe("live");
    expect(count(limiter, "c")).toBe("daily_cap");
  });
});
describe("input contract", () => {
  it("enforces 12 candidates, 20 lineup acts, 200-char text and real calendar dates", () => {
    const base = { mode: "qloo", scenario: sample };
    expect(requestSchema.safeParse(base).success).toBe(true);
    for (const scenario of [
      { ...sample, candidates: Array.from({ length: 13 }, (_, i) => ({ ...sample.candidates[0], name: `Sample candidate ${i}` })) },
      { ...sample, lineup: Array.from({ length: 21 }, (_, i) => ({ ...sample.lineup[0], name: `Sample lineup ${i}` })) },
      { ...sample, festival_name: "x".repeat(201) }, { ...sample, date: "2026-02-30" },
      { ...sample, candidates: [{ ...sample.candidates[0], available: "yes" }] },
      { ...sample, candidates: [{ ...sample.candidates[0], notes: "x".repeat(201) }] },
      { ...sample, cancelled_act: { ...sample.cancelled_act, name: sample.lineup[0].name } },
    ]) expect(requestSchema.safeParse({ ...base, scenario }).success).toBe(false);
  });
});
