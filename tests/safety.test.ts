import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { RunLimiter } from "../src/lib/limits";
import { requestSchema } from "../src/lib/contracts";
import sample from "../samples/scenario.json";

describe("fixture and server boundary guards", () => {
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
  it("allows five per IP, isolates IPs and resets after ten minutes", () => {
    let now = 0;
    const limiter = new RunLimiter(() => now);
    expect(Array.from({ length: 6 }, () => limiter.checkIp("synthetic-ip"))).toEqual([true, true, true, true, true, false]);
    expect(limiter.checkIp("other-ip")).toBe(true);
    now = 600_000;
    expect(limiter.checkIp("synthetic-ip")).toBe(true);
  });
  it("caps global spend at 300 runs per UTC day", () => {
    let now = 0;
    const limiter = new RunLimiter(() => now);
    for (let i = 0; i < 300; i++) expect(limiter.takeDaily()).toBe(true);
    expect(limiter.takeDaily()).toBe(false);
    now = 86_400_000;
    expect(limiter.takeDaily()).toBe(true);
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
