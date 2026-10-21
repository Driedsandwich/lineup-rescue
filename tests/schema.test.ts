import { describe, expect, it } from "vitest";
import { definitions, strictSchema, toolSchemas } from "../src/lib/agent/tools";
import { submissionSchema, type Submission } from "../src/lib/contracts";

const UNSUPPORTED = ["$schema", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "maxItems", "pattern"];

function keywords(schema: unknown, found = new Map<string, unknown[]>()) {
  if (Array.isArray(schema)) schema.forEach(item => keywords(item, found));
  else if (schema && typeof schema === "object") {
    for (const [key, value] of Object.entries(schema)) {
      if (key === "properties" && value && typeof value === "object") Object.values(value).forEach(child => keywords(child, found));
      else { found.set(key, [...(found.get(key) ?? []), value]); keywords(value, found); }
    }
  }
  return found;
}

describe("strict tool schemas", () => {
  it("send no constraint keywords that strict tool use rejects", () => {
    for (const mode of ["qloo", "baseline"] as const) {
      for (const tool of definitions(mode)) {
        const found = keywords(tool.input_schema);
        for (const key of UNSUPPORTED) expect(found.has(key), `${tool.name} sends ${key}`).toBe(false);
        for (const value of found.get("minItems") ?? []) expect(value as number).toBeLessThanOrEqual(1);
        for (const value of found.get("additionalProperties") ?? []) expect(value).toBe(false);
      }
    }
  });

  it("keeps property names that look like keywords", () => {
    const schema = strictSchema({ type: "object", properties: { maximum: { type: "string", maxLength: 3 } }, required: ["maximum"], additionalProperties: false });
    expect(schema).toEqual({ type: "object", properties: { maximum: { type: "string" } }, required: ["maximum"], additionalProperties: false });
  });

  it("still enforces the limits server-side with zod", () => {
    expect(() => toolSchemas.local_heat.parse({ entity_id: "x".repeat(201), region: "Bristol" })).toThrow();
  });
  it("exposes only model decisions and copy, with no response envelope or evidence", () => {
    for (const mode of ["qloo", "baseline"] as const) {
      const schema = definitions(mode).find(t => t.name === "submit_rescue_plan")!.input_schema;
      expect(Object.keys(schema.properties!).sort()).toEqual(["announcement", "plans", "refund_checklist"]);
    }
    expect(Object.keys(submissionSchema.shape.plans.element.shape).sort()).toEqual(["caveats", "id", "promoted_act", "rationale", "replacement", "title", "type"]);
  });
  const draft: Submission = {
    plans: [{ id: "A", title: "Sample", type: "direct_swap", replacement: "Sample replacement", promoted_act: null, rationale: "x".repeat(600), caveats: Array(4).fill("x".repeat(200)) }],
    announcement: { short_post: "x".repeat(280), email_subject: "x".repeat(120), email_body: "x".repeat(1200) },
    refund_checklist: [{ ticket_type: "Sample ticket", items: Array(6).fill("x".repeat(200)) }],
  };
  it("accepts all submission size limits at their boundaries", () => {
    expect(submissionSchema.safeParse({ ...draft, plans: Array(3).fill(draft.plans[0]) }).success).toBe(true);
    expect(submissionSchema.safeParse({ ...draft, plans: [] }).success).toBe(true);
  });
  it.each([
    ["plans", (s: Submission) => { s.plans = Array(4).fill(s.plans[0]); }],
    ["rationale", (s: Submission) => { s.plans[0].rationale += "x"; }],
    ["caveat count", (s: Submission) => { s.plans[0].caveats.push("x"); }],
    ["caveat length", (s: Submission) => { s.plans[0].caveats[0] += "x"; }],
    ["post", (s: Submission) => { s.announcement.short_post += "x"; }],
    ["subject", (s: Submission) => { s.announcement.email_subject += "x"; }],
    ["email", (s: Submission) => { s.announcement.email_body += "x"; }],
    ["checklist count", (s: Submission) => { s.refund_checklist[0].items.push("x"); }],
    ["checklist length", (s: Submission) => { s.refund_checklist[0].items[0] += "x"; }],
  ] as const)("rejects excessive %s server-side", (_, change) => {
    const input = structuredClone(draft);
    change(input);
    expect(submissionSchema.safeParse(input).success).toBe(false);
  });
  it("rejects model-written server metadata and evidence", () => {
    expect(submissionSchema.safeParse({ ...draft, trace: [] }).success).toBe(false);
    expect(submissionSchema.safeParse({ ...draft, plans: [{ ...draft.plans[0], evidence: {} }] }).success).toBe(false);
  });
});
