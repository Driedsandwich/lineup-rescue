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
- `POST /api/rescue` runs one agent session and returns JSON. Hard deadline 50 s per request (`maxDuration = 60`).
- **Qloo client** (server-only module): base URL from `QLOO_BASE_URL` (default `https://hackathon.api.qloo.com`), header `X-Api-Key` from `QLOO_API_KEY`, GET with comma-joined arrays, 15 s timeout, one retry on 429/5xx with backoff, typed errors. Tolerant parsing (results may be an array or an object holding `entities` / `heatmap` / `tags`; affinity may be `affinity` or `query.affinity`).
- **Private server-side cache**: in-memory LRU keyed by path + sorted parameters, 24 h TTL. Nothing from live Qloo responses is ever written to the repository or to disk inside it.
- **LLM**: Anthropic TypeScript SDK (`@anthropic-ai/sdk`), model `claude-haiku-5-5`, manual agentic loop on `client.messages.create` (non-beta). Tools are JSON-schema tools with `strict: true` and `additionalProperties: false`. The run ends when the model calls `submit_rescue_plan` (strict schema = the response contract below). `output_config: { effort: "medium" }`, `max_tokens: 16000`, at most 8 model turns. Append the full `response.content` every turn (thinking blocks must be passed back unchanged). Handle `stop_reason` values `tool_use`, `end_turn` (re-prompt once to submit), `max_tokens`, `pause_turn`, `refusal` (return a clear error; no fallback model).
- **Mock modes** (so the whole app runs in CI and before keys exist):
  - Qloo mock when `QLOO_API_KEY` is unset or `QLOO_MODE=mock`: hand-written **synthetic** fixtures with fake IDs (`mock-artist-001` style) and clearly fictional sample names. Deterministic pseudo-affinity. A UI banner says "Sample data". Live responses are never recorded into fixtures; a test fails if any fixture contains a UUID-shaped string.
  - LLM mock when `ANTHROPIC_API_KEY` is unset or `LLM_MODE=mock`: a deterministic planner that calls the same tools in a fixed order and fills templated text. Same response contract.
- **Abuse and spend protection**: per-IP limit (5 runs / 10 min), global cap (300 runs / day, in-memory), input limits (≤ 12 candidates, ≤ 20 lineup acts, ≤ 200 characters per text field), and a result cache keyed by a hash of the normalised scenario (identical sample runs cost nothing).
- **Privacy**: only act names, entity IDs and the city go to Qloo. Booker notes go only to the LLM. The UI asks users not to enter personal data. Server logs record counts and timings only.

## 6. Agent tools (exposed to the model)

| Tool | Does | Qloo call |
|---|---|---|
| `resolve_acts` | Names → entities, with `matched` / `ambiguous` (options) / `not_found` | `/search?types=urn:entity:artist` |
| `rank_against_audience` | Score given option IDs against signal IDs in a city | `/v2/insights` `filter.type=urn:entity:artist`, `filter.results.entities`, `signal.interests.entities`, `signal.location.query` |
| `local_heat` | How strong an act's audience is around a region | `/v2/insights` `filter.type=urn:heatmap`, `signal.interests.entities`, `filter.location.query` |
| `submit_rescue_plan` | Final structured answer | — |

Hard-constraint filtering is plain code before the agent starts (not a model decision). Tool results carry `status` and short, bounded payloads.

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
  "llm": "live | mock",
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

## 8. Quality bar

- Unit tests (vitest): query serialisation, response parsing variants, hard-constraint filter, plan assembly, fixture guard, rate limiter.
- `npm run smoke`: runs a full rescue in mock mode for both `qloo` and `baseline` and asserts the response keys.
- `npm run build` passes with no type errors. ESLint clean.
- README: problem, how Qloo is used and why, setup from a clean clone, env vars, mock mode, limitations, data handling, MIT licence.
