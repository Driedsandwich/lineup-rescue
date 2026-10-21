import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { RunLimiter, QlooRunLimiter } from "../src/lib/limits";
import { clientKey } from "../src/lib/client-key";
import { runAgent, type MessageSender } from "../src/lib/agent/loop";
import sample from "../samples/scenario.json";

it("groups canonical IPv6 /64 prefixes while preserving IPv4 hashes", () => {
  expect(clientKey("2001:db8:1234:5678::1")).toBe(clientKey("2001:0DB8:1234:5678:ffff:abcd:0:2"));
  expect(clientKey("2001:db8:1234:5678::1")).not.toBe(clientKey("2001:db8:1234:5679::1"));
  expect(clientKey("2001:db8::1")).toBe(clientKey("2001:0db8:0000:0000:0:0:0:2"));
  expect(clientKey("::ffff:192.0.2.1")).toBe(clientKey("::ffff:c000:201"));
  for (const ip of ["192.0.2.1", "198.51.100.2", "unknown"]) {
    expect(clientKey(ip)).toBe(createHash("sha256").update(ip).digest("hex"));
  }
});

it("evicts the oldest key and admits new keys in both full tables", () => {
  let now = 0;
  const model = new RunLimiter(() => now, 1, 50_000);
  const qloo = new QlooRunLimiter(() => now, 1, 10);
  for (let i = 0; i < 10_000; i++) {
    now++;
    const reserved = model.reserve(`synthetic-${i}`);
    expect(reserved).toHaveProperty("finish");
    if ("finish" in reserved) reserved.finish(true);
    expect(qloo.reserve(`synthetic-${i}`)).toBe(true);
  }
  expect(model.reserve("new")).toHaveProperty("finish");
  expect(qloo.reserve("new")).toBe(true);
  expect(model.reserve("synthetic-1")).toEqual({ reason: "ip_limit" });
  expect(qloo.reserve("synthetic-1")).toBe(false);
  expect(model.reserve("synthetic-0")).toHaveProperty("finish");
  expect(qloo.reserve("synthetic-0")).toBe(true);
});

it("resets Qloo windows independently of the per-key UTC day counter, without counting denials", () => {
  let now = Date.parse("2026-10-21T23:49:00Z");
  const limiter = new QlooRunLimiter(() => now, 1, 2);
  expect(limiter.reserve("a")).toBe(true);
  expect(limiter.reserve("a")).toBe(false);
  expect(limiter.reserve("b")).toBe(true);
  now += 600_000;
  expect(limiter.reserve("a")).toBe(true);
  now = Date.parse("2026-10-22T00:00:00Z");
  expect(limiter.reserve("a")).toBe(false); // ten-minute bucket survives midnight
  now += 600_000;
  expect(limiter.reserve("a")).toBe(true);
});

it.each(["", "0", "-1", "1.5", "no", "Infinity", "9007199254740992"])("defaults invalid Qloo overrides %j", value => {
  vi.stubEnv("QLOO_RUNS_PER_IP", value);
  vi.stubEnv("QLOO_RUNS_PER_IP_DAY", value);
  let now = 0;
  const limiter = new QlooRunLimiter(() => now);
  for (let window = 0; window < 10; window++) {
    for (let i = 0; i < 30; i++) expect(limiter.reserve("a")).toBe(true);
    expect(limiter.reserve("a")).toBe(false);
    now += 600_000;
  }
  expect(limiter.reserve("a")).toBe(false);
  expect(limiter.reserve("b")).toBe(true);
  now = 86_400_000;
  expect(limiter.reserve("a")).toBe(true);
});

it.each(["provider", "refusal", "max_tokens", "unfinished", "abort"])("counts a sent %s attempt on both model counters", async reason => {
  const limiter = new RunLimiter(Date.now, 1, 2);
  const controller = new AbortController();
  const send = vi.fn<MessageSender>(async () => {
    if (reason === "abort") { controller.abort(); return new Promise(() => {}); }
    if (reason === "provider") throw new Error("Synthetic failure");
    return { stop_reason: reason === "unfinished" ? "end_turn" : reason, content: [] } as never;
  });
  const run = runAgent({ mode: "baseline", scenario: sample }, controller.signal, { send, reserveModel: () => limiter.reserve("a") });
  if (reason === "abort") await expect(run).rejects.toMatchObject({ code: "deadline" });
  else expect((await run).llm).toBe("fallback");
  expect(send).toHaveBeenCalled();
  expect(limiter.reserve("a")).toEqual({ reason: "ip_limit" });
  const other = limiter.reserve("b");
  expect(other).toHaveProperty("finish");
  expect(limiter.reserve("c")).toEqual({ reason: "daily_cap" });
});

it("releases both counters when aborted after reservation but before the first send", async () => {
  const limiter = new RunLimiter(Date.now, 1, 1);
  const controller = new AbortController();
  const send = vi.fn<MessageSender>();
  await expect(runAgent({ mode: "baseline", scenario: sample }, controller.signal, { send, reserveModel: () => {
    const reserved = limiter.reserve("a");
    controller.abort();
    return reserved;
  } })).rejects.toMatchObject({ code: "deadline" });
  expect(send).not.toHaveBeenCalled();
  expect(limiter.reserve("a")).toHaveProperty("finish");
});
