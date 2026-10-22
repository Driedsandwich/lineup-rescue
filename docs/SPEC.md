# Encore Rescue — product and technical spec (v0.1)

## 1. Problem

A festival headliner cancels on the day or the day before. The booker phones agents and managers and collects a short list of acts that are free, nearby, and able to arrive within 48 hours with crew and gear. Then comes the hardest question: which of those acts can take the slot without the night feeling like a downgrade to the people who bought tickets for the cancelled act and for the rest of the lineup? Today that call is made on instinct and on headline metrics such as monthly listeners, which a music analytics company itself says were never designed to predict ticket buying.

Encore Rescue is an agentic tool for that night. It does not search the whole world for "similar artists". It takes the booker's feasible list, checks the hard constraints first, and then uses Qloo's taste graph to compare the feasible options against two audiences at once (the cancelled act's audience and the remaining lineup's audience) in the festival's city. It also considers promoting an act already on the bill. It ends with a ready-to-edit announcement and a refund-handling checklist per ticket type.

## 2. Users and scope

- User: a booker, promoter or festival operations lead at a mid-to-large music festival.
- In scope: one cancelled act, up to 12 feasible candidates, up to 20 acts on the remaining lineup, one city.
- Out of scope: predicting availability, fees or ticket sales; contracts; payments; any personal data about people.

## 3. Demo flow (target: understood in 2 minutes)

1. **Scenario.** A fictional festival in a real city with a lineup by stage and time. The headliner has just cancelled. A sample scenario is preloaded and editable.
2. **Phone list.** The booker's candidates, each with: available (yes/no), can arrive within 48 h with crew and gear (yes/no), travel time in hours (optional), notes (free text, never sent to Qloo).
3. **Run.** The agent:
   1. applies the hard constraints and lists excluded candidates with the reason;
   2. resolves every act name to a Qloo entity; ambiguous names come back as "needs input" with options; names Qloo does not know are shown as "not in the Qloo catalog" and are never scored or guessed;
   3. ranks the eligible candidates against the cancelled act's audience in the city;
   4. ranks the eligible candidates against the remaining lineup's audience in the city;
   5. checks how strong each finalist's audience is around the festival's region (heatmap);
   6. tries the "promote from within" path: rank acts already on the bill against the cancelled act's audience, move the best fit up, and fill the freed slot from the candidates;
   7. composes 2–3 rebuild plans with the evidence behind each, plus caveats;
   8. drafts the same-night announcement (short social post and an email to ticket holders) and a refund-handling checklist per ticket type. The checklist lists what the organiser must decide or verify (e.g. eligibility under the ticket terms, deadlines, channel). It never invents a refund policy.
4. **Without Qloo (baseline).** The same model, same inputs and same instructions, with the Qloo tools removed. The UI shows both results side by side and highlights where the Qloo-grounded ranking differs from the LLM-only guess. This makes the "Qloo is the differentiator" claim testable by a judge in one click.
5. **Trace.** Every tool call is listed: tool name, the request parameters with entity IDs shortened, status (ok / empty / needs_input / error), result count and latency. This is the "redacted request-to-result explanation" the submission guide asks for.

## 4. Practice facts the design follows (sources in the Devpost description)

- When an act cancels, the questions asked are: who is free, who is nearby, who can be there within 48 hours with their team and gear, and above all who can replace the act without it clashing (Belgian public broadcaster RTBF, 2025). Encore Rescue applies the first three as hard filters and spends Qloo on the last one.
- Organisers have promoted an act already on the bill to the headline slot and filled the freed slot with a new act (Rock Werchter, July 2025).
- At short notice, a replacement may require full payment of fees rather than a deposit (Festival Pro, 2025). Encore Rescue does not price anything; it flags fee questions in the checklist.

## 5. Architecture

- Next.js (App Router) + TypeScript. Server code runs on the **Node runtime** only (`export const runtime = "nodejs"`). No platform-specific services (no KV, Blob, Edge Config). The app must run with `npm run build && npm start` on any Node 22 host.
- `POST /api/rescue` runs one agent session and returns JSON. Hard deadline 50 s per request (`maxDuration = 60`). The live model must complete an accepted submission within 40 s, including body reading and pre-resolution, leaving the remaining request budget for deterministic assembly.
- **Qloo client** (server-only module): base URL from `QLOO_BASE_URL` (default `https://hackathon.api.qloo.com`), header `X-Api-Key` from `QLOO_API_KEY`, GET with comma-joined arrays, 15 s timeout per HTTP attempt after queueing, typed errors. All live clients share a FIFO gate per server instance: at most `QLOO_MAX_PER_SECOND` starts in any rolling 1,000 ms and the same number in flight (positive integer, default 8; invalid or empty values use the default). Aborted queued requests are removed without sending. HTTP 429 waits for numeric `x-second-ratelimit-reset` seconds (default 1 for missing/invalid values, clamped to 1–5 seconds), with at most two retries. HTTP 5xx retains one 300 ms retry. Retry waits honour cancellation; every retry passes through the gate. Tolerant parsing (results may be an array or an object holding `entities` / `heatmap` / `tags`; affinity may be `affinity` or `query.affinity`).
- **Private server-side cache**: in-memory LRU keyed by path + sorted parameters, 24 h TTL. Nothing from live Qloo responses is ever written to the repository or to disk inside it.
- **LLM**: Anthropic TypeScript SDK (`@anthropic-ai/sdk`), model `claude-haiku-5-5`, manual agentic loop on `client.messages.create` (non-beta). Tools are JSON-schema tools with `strict: true` and `additionalProperties: false`. The run ends when the model calls `submit_rescue_plan` with decisions and draft copy only. The server composes the public response contract below, completing missing evidence itself. `output_config: { effort: "medium" }`, `max_tokens: 16000`, a target of at most 3 model turns (one parallel gathering batch, at most one follow-up batch, then submission), with an 8-turn safety limit for corrections and stop handling. Append the full `response.content` every turn (thinking blocks must be passed back unchanged). Handle `stop_reason` values `tool_use`, `end_turn` (re-prompt once to submit), `max_tokens`, `pause_turn`, `refusal`. A deadline, provider error, refusal, output limit or unfinished run aborts model work and uses the existing fixed-rule planner with the same scenario, hard filters, Qloo client and observed evidence. Cached observations, including empty results, are reused. No synthetic Qloo substitution or second model is used. Qloo pre-resolution failure still returns an error.
- **Mock modes** (so the whole app runs in CI and before keys exist):
  - Qloo mock when `QLOO_API_KEY` is unset or `QLOO_MODE=mock`: hand-written **synthetic** fixtures with fake IDs (`mock-artist-001` style) and clearly fictional sample names. Deterministic pseudo-affinity. A UI banner says "Sample data". Live responses are never recorded into fixtures; a test fails if any fixture contains a UUID-shaped string.
  - LLM mock when `ANTHROPIC_API_KEY` is unset or `LLM_MODE=mock`: a deterministic planner that calls the same tools in a fixed order and fills templated text. Same response contract.
- **Abuse and spend protection**: live-model limits default to 20 runs per IP / 10 min and 1,500 runs / UTC day, kept in each server instance's memory and not shared across instances, configurable via positive integers `LLM_RUNS_PER_IP` and `LLM_RUNS_PER_DAY`. Invalid or empty values use the defaults. At either limit the server returns HTTP 200 with fixed-rule plans from the same Qloo evidence and no model call, marked `llm: "fallback"`. Baseline fallback uses the same scenario and constraints without Qloo. In-flight model work reserves both counters atomically. Any run that sends at least one model request stays counted on both counters, regardless of success, fallback, provider error, refusal, output limit, unfinished work, deadline or client abort. Reservations are released only if no model request was sent, including cancellation before the first send. Cache hits, shared requests, deterministic mock runs and limit fallbacks without model work do not consume model slots. Failed model attempts may still incur charges. Input limits (≤ 12 candidates, ≤ 20 lineup acts, ≤ 200 characters per text field, 64 KiB body) remain hard validation with HTTP 400. The result cache uses a hash of the normalised scenario. Fallback results are never stored in this cache. Concurrent identical requests may share the current run.
- **Measured Qloo quota**: hackathon response headers report 10 requests/second and 50,000 requests/month, with one monthly window covering the judging period. Fifteen parallel search requests returned ten HTTP 200s and five HTTP 429s. The 8-act live sample used about 17 Qloo requests and returned HTTP 200 in 20.1 seconds with 13 trace rows and no errors. These observations inform the defaults below; request counts depend on workload and caches.
- **Daily Qloo request budget**: `QLOO_CALLS_PER_DAY` is a positive integer, default 2,000 per UTC day per instance; invalid or empty values use the default. Every HTTP attempt actually sent counts, including retries and failed requests. Result-cache hits, response-cache hits and mock mode do not consume it. Before `resolve_acts`, alongside the Qloo run limiter, a reached budget selects the same `qloo_limit` fixed-rule path below, with no Qloo or model call and no result caching. Already admitted runs may finish even if they cross the budget. Counters reset at UTC midnight or instance restart and do not guarantee the account-wide monthly quota.
- **Live-Qloo brake**: a second per-instance limiter checks before `resolve_acts`. Positive integers `QLOO_RUNS_PER_IP` (default 10 per hashed client key / 10 min) and `QLOO_RUNS_PER_IP_DAY` (default 40 per hashed client key / UTC day) configure it; invalid or empty values use defaults. It counts runs, not individual Qloo calls, including fixed-rule Qloo work after a model limit and failed/cancelled Qloo runs. Result-cache hits, shared in-flight runs, baseline requests and mock-Qloo mode do not consume slots. At either limit it never refuses: HTTP 200 on the existing baseline fixed-rule path, no Qloo or model calls, `llm: "fallback"`, a `fallback` trace row with reason `qloo_limit`, evidence "Fixed-rule suggestion; no audience data.", and disclaimer "Audience data was not fetched because of high request volume from this address. These plans use fixed rules only." The response retains the requested mode. These results are never cached.
- **Client keys and table bounds**: both limiters share the same hashed key. IPv4 hashing is unchanged; IPv6 is canonicalised to its /64 prefix before hashing, so addresses in the same /64 share limits. Each table holds at most 10,000 keys and evicts the oldest inserted entry when full, admitting new visitors instead of refusing new keys. Eviction discards the evicted key's counts. All limits and caches remain per instance, reset on restart and are not a distributed or account-wide quota guarantee.
- **Privacy**: only act names, entity IDs and the city go to Qloo. Booker notes go only to the LLM. The UI asks users not to enter personal data. Server logs record counts and timings only.

## 6. Agent tools (exposed to the model)

| Tool | Does | Qloo call |
|---|---|---|
| `resolve_acts` | Offered only for names not processed by server pre-resolution; names → entities, with `matched` / `ambiguous` (options) / `not_found` | `/search?types=urn:entity:artist` |
| `rank_against_audience` | Score given option IDs against signal IDs in a city | `/v2/insights` `filter.type=urn:entity:artist`, `filter.results.entities`, `signal.interests.entities`, `signal.location.query` |
| `local_heat` | How strong an act's audience is around a region | `/v2/insights` `filter.type=urn:heatmap`, `signal.interests.entities`, `filter.location.query` |
| `submit_rescue_plan` | Decisions and draft copy; server completes evidence and the public response | — |

Hard-constraint filtering is plain code before the agent starts (not a model decision). Tool results carry `status` and short, bounded payloads. Pre-resolution IDs are final and are supplied in the first model message; ambiguous names require the user, and not-found names cannot be repaired by the model.

The first user message explicitly supplies `allowed_replacements` (eligible, resolved scenario names), `allowed_promotions` (resolved remaining-lineup names), and exact `ticket_types`, with instructions to copy their spellings. Names requiring user input, absent from the catalog, or excluded by hard constraints appear separately under `cannot_be_used`. Baseline lists include eligible candidates and the remaining lineup without asserting catalog resolution.

The submission has only `plans` (up to 3, with id, title, type, replacement, promoted_act, rationale up to 600 characters, up to 4 caveats each up to 200 characters), `announcement` (short_post up to 280, email_subject up to 120, email_body up to 1200 characters), and `refund_checklist` (one entry per ticket type, up to 6 items each up to 200 characters). Evidence, metadata, trace and disclaimers are server-owned. Missing original-audience ranking, exact remaining-lineup ranking, promotion fill fit and each finalist's local heat are fetched in parallel before composition. Empty or failed observations stay unknown and retain their trace status. The model is instructed that fit against the remaining lineup and local heat are measured by the server after submission and attached to the final response, so its rationale must not describe any measurement as pending or not yet measured. The server does not rewrite model text. Heat labels that are missing or match `/^[0-9b-hjkmnp-z]{4,12}$/` are summarised as area count, scenario city and top local affinity (not a probability), without showing geohashes. Real place names may be retained.

Each plan is validated independently. If any plan passes, valid plans retain their IDs; invalid siblings are dropped. The first valid occurrence of a duplicate ID is retained. Each dropped plan adds a short caveat in response `disclaimers` and an error trace row with `tool: "submit_rescue_plan"`, `params: { reason, plan_id }`, `result_count: 0`, and `ms: 0`. Reasons contain validation details but no act names, draft copy or prompts. If all submitted plans fail, every rejected plan is traced and the first specific error and `plan_id` return to the model for correction. An explicitly empty plan list remains valid. Submission-wide schema errors are traced with `plan_id: null`.

Refund checklist coverage is normalised rather than rejected: ticket types match after trimming and ignoring case, unknown and duplicate entries are dropped (the first matching entry wins), and missing ticket types receive the existing server default items. The response uses the exact scenario spellings and order. Changes add an `ok` submission trace row describing normalisation without ticket names. Submission size and content limits, strict tool schemas, response contract, 40-second model budget and fallback behaviour remain unchanged.

Trace keeps the section 7 shape: server-initiated calls have `params.by: "server"`; one `model_turn` entry per model request records status, elapsed milliseconds and requested tool count in `result_count`.

## 7. Response contract (`POST /api/rescue`)

Request:
```json
{
  "mode": "qloo",
  "scenario": {
    "festival_name": "string",
    "city": "string",
    "date": "YYYY-MM-DD",
    "cancelled_act": { "name": "string", "slot": "string" },
    "lineup": [{ "name": "string", "stage": "string", "slot": "string" }],
    "candidates": [{ "name": "string", "available": true, "can_arrive_48h": true, "travel_hours": 3, "notes": "string" }],
    "ticket_types": ["Single day", "Weekend pass", "VIP"]
  },
  "resolutions": { "Act name": "chosen-entity-id" }
}
```
`mode` is `"qloo"` or `"baseline"`. `resolutions` is optional (answers to earlier `needs_input`).

Response:
```json
{
  "run_id": "string",
  "mode": "qloo",
  "data_source": "live | mock",
  "llm": "live | mock | fallback",
  "excluded": [{ "name": "string", "reason": "string" }],
  "needs_input": [{ "name": "string", "options": [{ "entity_id": "string", "label": "string" }] }],
  "not_in_catalog": ["string"],
  "plans": [{
    "id": "A",
    "title": "string",
    "type": "direct_swap | promote_and_fill",
    "replacement": "string",
    "promoted_act": "string or null",
    "evidence": { "fit_original_audience": "string", "fit_lineup_audience": "string", "local_heat": "string" },
    "rationale": "string",
    "caveats": ["string"]
  }],
  "announcement": { "short_post": "string", "email_subject": "string", "email_body": "string" },
  "refund_checklist": [{ "ticket_type": "string", "items": ["string"] }],
  "trace": [{ "tool": "string", "params": {}, "status": "ok | empty | needs_input | error", "result_count": 0, "ms": 0 }],
  "disclaimers": ["string"]
}
```
Fixed disclaimers include: Qloo results describe what groups tend to like, not what one person will do; the tool does not predict availability, fees or ticket sales.

`llm: "fallback"` means the fixed-rule planner assembled the response after a usage limit or incomplete model work. The disclaimer names the reason: "Per-IP usage limit for the language model reached.", "Daily usage limit for the language model reached on this server.", "The language model time budget was reached.", or "The language model did not complete an accepted plan." It then states: "These plans were assembled by fixed rules from the same Qloo evidence." Baseline fallback instead names the same scenario and hard constraints and states that no Qloo evidence was used. The UI shows the reason in a calm status notice alongside the plans. The complete trace remains present, including any `model_turn` timings and a `fallback` row. Usage-limit rows have reason `ip_limit` or `daily_cap`, with no model call; model recovery rows retain the failure reason (including `deadline`) and `budget_ms`.

For the Qloo brake, the trace reason is `qloo_limit` without `budget_ms`. It uses the audience-data disclaimer specified above and baseline fixed-rule evidence even when the requested mode is `qloo`. No audience lookup or model attempt occurs.

Every error response includes `{ "error": "code", "message": "safe explanation", "trace": [] }`, with the trace collected so far (empty when work has not started). Validation errors may also include `issues`. Raw provider bodies, credentials, prompts and model prose are never included. Qloo failure or the hard request deadline may still prevent a response with plans; errors retain their observations.

## 8. Quality bar

- Unit tests (vitest): query serialisation, response parsing variants, hard-constraint filter, plan assembly, fixture guard, rate limiter.
- `npm run smoke`: runs a full rescue in mock mode for both `qloo` and `baseline` and asserts the response keys.
- `npm run build` passes with no type errors. ESLint clean.
- README: problem, how Qloo is used and why, setup from a clean clone, env vars, mock mode, limitations, data handling, MIT licence.
