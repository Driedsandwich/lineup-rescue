import { z } from "zod";

const text = z.string().trim().min(1).max(200);
export const candidateSchema = z.strictObject({
  name: text,
  available: z.boolean(),
  can_arrive_48h: z.boolean(),
  travel_hours: z.number().finite().min(0).max(1000).optional(),
  notes: z.string().trim().max(200),
});
export const scenarioSchema = z.strictObject({
  festival_name: text,
  city: text,
  date: z.iso.date(),
  cancelled_act: z.strictObject({ name: text, slot: text }),
  lineup: z.array(z.strictObject({ name: text, stage: text, slot: text })).max(20),
  candidates: z.array(candidateSchema).max(12),
  ticket_types: z.array(text).min(1).max(12),
}).superRefine((scenario, ctx) => {
  const names = [scenario.cancelled_act.name, ...scenario.lineup.map(a => a.name), ...scenario.candidates.map(a => a.name)];
  if (new Set(names.map(n => n.toLowerCase())).size !== names.length) {
    ctx.addIssue({ code: "custom", message: "Each act must have a unique name across cancelled act, lineup and candidates." });
  }
  if (new Set(scenario.ticket_types.map(n => n.toLowerCase())).size !== scenario.ticket_types.length) {
    ctx.addIssue({ code: "custom", message: "Ticket types must be unique." });
  }
});
export const requestSchema = z.strictObject({
  mode: z.enum(["qloo", "baseline"]),
  scenario: scenarioSchema,
  resolutions: z.record(text, text).refine(v => Object.keys(v).length <= 33, "At most 33 resolutions").optional(),
});
const copy = z.string().min(1).max(4000);
export const planSchema = z.strictObject({
  id: text,
  title: copy,
  type: z.enum(["direct_swap", "promote_and_fill"]),
  replacement: text,
  promoted_act: text.nullable(),
  evidence: z.strictObject({ fit_original_audience: copy, fit_lineup_audience: copy, local_heat: copy }),
  rationale: copy,
  caveats: z.array(copy).max(12),
});
export const needsInputSchema = z.strictObject({
  name: text,
  options: z.array(z.strictObject({ entity_id: text, label: text })).max(5),
});
export const traceSchema = z.strictObject({
  tool: text,
  params: z.record(z.string(), z.unknown()),
  status: z.enum(["ok", "empty", "needs_input", "error"]),
  result_count: z.number().int().min(0),
  ms: z.number().min(0),
});
export const responseSchema = z.strictObject({
  run_id: text,
  mode: z.enum(["qloo", "baseline"]),
  data_source: z.enum(["live", "mock"]),
  llm: z.enum(["live", "mock"]),
  excluded: z.array(z.strictObject({ name: text, reason: copy })).max(12),
  needs_input: z.array(needsInputSchema).max(33),
  not_in_catalog: z.array(text).max(33),
  plans: z.array(planSchema).max(3),
  announcement: z.strictObject({ short_post: copy, email_subject: copy, email_body: copy }),
  refund_checklist: z.array(z.strictObject({ ticket_type: text, items: z.array(copy).min(1).max(12) })).max(12),
  trace: z.array(traceSchema).max(100),
  disclaimers: z.array(copy).max(12),
});
// Submitted trace params are server-owned. The server replaces these empty objects
// with the actual redacted trace; this keeps every strict tool object closed.
export const submissionSchema = responseSchema.extend({
  trace: z.array(traceSchema.extend({ params: z.strictObject({}) })).max(100),
});
export type Scenario = z.infer<typeof scenarioSchema>;
export type RescueRequest = z.infer<typeof requestSchema>;
export type RescueResponse = z.infer<typeof responseSchema>;
export type Plan = z.infer<typeof planSchema>;
export type Trace = z.infer<typeof traceSchema>;
export type NeedsInput = z.infer<typeof needsInputSchema>;
