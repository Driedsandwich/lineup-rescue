import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { POST } from "../src/app/api/rescue/route";
import sample from "../samples/scenario.json";
import { responseSchema } from "../src/lib/contracts";

function request(body: unknown, ip: string) {
  return new Request("http://localhost/api/rescue", { method: "POST", headers: { "Content-Type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) });
}
it("runs both modes, caches normalised scenarios and keys resolutions separately", async () => {
  for (const mode of ["qloo", "baseline"] as const) {
    const response = await POST(request({ mode, scenario: sample }, `route-${mode}`));
    expect(response.status).toBe(200);
    const body = responseSchema.parse(await response.json());
    // Compare the actual HTTP response with the documented public contract,
    // independently of the zod schema used by the server.
    const spec = JSON.parse(readFileSync("docs/SPEC.md", "utf8").match(/Response:\n```json\n([\s\S]*?)\n```/)![1]);
    expect(Object.keys(body).sort()).toEqual(Object.keys(spec).sort());
    expect(Object.keys(body.plans[0]).sort()).toEqual(Object.keys(spec.plans[0]).sort());
    expect(Object.keys(body.plans[0].evidence).sort()).toEqual(Object.keys(spec.plans[0].evidence).sort());
    expect(Object.keys(body.announcement).sort()).toEqual(Object.keys(spec.announcement).sort());
    expect(Object.keys(body.refund_checklist[0]).sort()).toEqual(Object.keys(spec.refund_checklist[0]).sort());
    expect(Object.keys(body.trace[0]).sort()).toEqual(Object.keys(spec.trace[0]).sort());
    expect(body.mode).toBe(mode);
    expect(body.data_source).toBe("mock");
    expect(body.llm).toBe("mock");
    const cached = await POST(request({ mode, scenario: { ...sample, festival_name: ` ${sample.festival_name} ` } }, `route-${mode}`));
    expect(cached.headers.get("X-Result-Cache")).toBe("hit");
    expect((await cached.json()).run_id).toBe(body.run_id);
  }
  const resolved = await POST(request({ mode: "qloo", scenario: sample, resolutions: { "Sample Twin Lantern": "mock-artist-009" } }, "route-resolved"));
  expect(resolved.headers.get("X-Result-Cache")).toBe("miss");
  expect((await resolved.json()).needs_input).toEqual([]);
});
it("validates before running and returns safe errors for malformed and oversized bodies", async () => {
  expect((await POST(request({ mode: "qloo", scenario: {} }, "invalid"))).status).toBe(400);
  expect((await POST(new Request("http://localhost", { method: "POST", body: "invalid json" }))).status).toBe(400);
  expect((await POST(new Request("http://localhost", { method: "POST" }))).status).toBe(400);
  expect((await POST(new Request("http://localhost", { method: "POST", body: "x".repeat(65_537) }))).status).toBe(413);
});
it("rate-limits even cached requests", async () => {
  for (let i = 0; i < 5; i++) expect((await POST(request({ mode: "baseline", scenario: sample }, "limit-ip"))).status).toBe(200);
  const limited = await POST(request({ mode: "baseline", scenario: sample }, "limit-ip"));
  expect(limited.status).toBe(429);
  expect(limited.headers.get("Retry-After")).toBe("600");
});
it("enforces the 50-second deadline even on a stalled request body", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const body = new ReadableStream({ cancel });
  const pending = POST(new Request("http://localhost", { method: "POST", body, duplex: "half" } as RequestInit));
  await vi.advanceTimersByTimeAsync(50_000);
  const response = await pending;
  expect(response.status).toBe(504);
  expect(cancel).toHaveBeenCalledTimes(1);
});
