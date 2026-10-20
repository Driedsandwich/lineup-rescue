import { describe, expect, it } from "vitest";
import { definitions, strictSchema, toolSchemas } from "../src/lib/agent/tools";

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
});
