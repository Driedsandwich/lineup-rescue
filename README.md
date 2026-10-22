# Lineup Rescue

**Audience evidence for the night a headliner cancels.**

**Live demo:** https://lineup-rescue.vercel.app (live Qloo data and a live model; no login, free until the end of the Judging Period).

A festival booker has a short list of acts who can make it. The difficult decision is which replacement fits both the audience who came for the cancelled act and the audience for the rest of the bill. A plausible artist name from a language model is not evidence of that fit.

Lineup Rescue is a decision-support prototype for bookers, promoters and festival operations leads. It filters the booker's phone list, uses Qloo's aggregate taste graph to assess the eligible choices in the festival city, and prepares rebuild options, announcement drafts and a ticket-type checklist. It also considers promoting someone already on the bill and filling their freed slot. It does not make bookings or send messages.

## How the agent works

1. **Check feasibility in code.** Exclude acts marked unavailable, unable to arrive within 48 hours with crew and gear, or recorded as needing more than 48 hours of travel. Missing travel duration alone does not override a confirmed arrival. Availability and logistics come from the booker.
2. **Resolve public act names.** Search only allowed names in Qloo's artist catalog. Accept a unique exact match. Show ambiguous or non-exact matches as inline radio choices; submit those choices in `resolutions` on the next run. Recheck every chosen ID against the search options. Display missing names as not in the catalog and leave them unscored. Above the plans, an ambiguous cancelled act shows "Choose the catalog match for the cancelled act above, then re-run." A missing cancelled act shows "The cancelled act was not found in Qloo's catalog, so its audience cannot be compared. Check the spelling or try another act." Hard-excluded acts never reach Qloo.
3. **Compare two audiences.** Rank eligible candidates against the cancelled act, then against the remaining lineup, using the same city and fixed candidate IDs.
4. **Check the region.** Retrieve local audience heat for finalists. Empty evidence remains unknown, not zero.
5. **Test a promotion.** Rank existing lineup acts against the cancelled audience, then candidates against the promoted act to fill its original slot. Check fit to the remaining bill and heat for both affected acts.
6. **Prepare the response.** Return up to three supported plans with evidence, rationale and caveats, plus editable social/email drafts and a checklist for each ticket type. The model submits decisions and bounded draft copy only. The server validates eligibility, fetches missing rankings and finalist heat in parallel, and composes evidence and metadata. Empty or failed observations remain unknown in the response and trace. Model instructions explain that remaining-lineup fit and local heat are measured by the server after submission and attached to the response; rationales must not describe measurements as pending or not yet measured. Model text is not rewritten. Geohash-only or unnamed heat areas are summarised by area count, scenario city and top affinity (not a probability); real place names may be shown. A draft never confirms an unapproved booking or invents a refund entitlement.

The intended benefit is a more inspectable replacement decision under time pressure. This prototype has no measured claim of better booking outcomes or model accuracy.

## Exactly where Qloo is used

All calls are server-side GET requests against `QLOO_BASE_URL` (default `https://hackathon.api.qloo.com`), authenticated with the private `X-Api-Key` header. Array values are comma-joined.

| Tool / endpoint | Parameters | Why it is needed |
| --- | --- | --- |
| `resolve_acts` / `/search` | `query=<act name>`, `types=urn:entity:artist`, `take=5` | Obtain artist entity IDs, restrict entity type, and offer at most five catalog choices rather than guessing an identity. No tags are inferred or used. |
| `rank_against_audience` / `/v2/insights` | `filter.type=urn:entity:artist`, `filter.results.entities=<option IDs>`, `signal.interests.entities=<audience signal IDs>`, `signal.location.query=<festival city>`, `take=<option count>` | Compare the feasible list against the cancelled act or lineup audience in the same city. Restricting results keeps the agent inside the booker's list. Repeated with lineup IDs as options and a promoted act as a signal to evaluate both promotion and backfill. |
| `local_heat` / `/v2/insights` | `filter.type=urn:heatmap`, `signal.interests.entities=<one act ID>`, `filter.location.query=<festival city>`, `take=3` | Inspect up to three regional audience cells for each finalist. This adds geographic context to the artist comparisons. |
| `submit_rescue_plan` | No Qloo request | Validate the structured result and attach the server-owned evidence and trace. |

Example request-to-result path in the **synthetic** demo: `Sample Velvet Comet` resolves to a fake artist ID; `Sample Twin Lantern` produces two choices. After selection, the client sends its chosen ID in `resolutions`. The agent uses the resolved cancelled-act ID as the audience signal and only eligible candidate IDs as options, in Bristol. The returned affinity evidence appears on the plan cards. Expanding **Tool trace** shows each model turn and its duration, plus tools, shortened IDs, parameters, status, result counts and elapsed milliseconds. Server-initiated calls are labelled; model rows count requested tool calls. No live response is embedded in this README or shipped as a fixture.

Meters display an available affinity between 0 and 1, never a probability or sales forecast. Values outside that display range remain in the evidence text without a meter. When an evidence field contains multiple values, its meter shows the first and the full text retains the rest. Different signals are not calibrated against one another; this is not a combined score.

## What the LLM-only comparison shows

**Rescue with Qloo** runs the grounded route. **Compare with LLM-only** adds a control column, first running Qloo if needed. Both requests use an unchanged scenario and the same resolution choices. Editing the scenario clears earlier results; changing a catalog choice marks the old Qloo result as pending and clears the baseline until rerun.

The live comparison uses the same model, system instructions, hard constraints and scenario. The baseline removes the three Qloo data tools, leaving only structured submission. After server pre-resolution, the grounded model is offered ranking and heat tools; resolution is offered only if names remain unprocessed. Server-owned metadata and available tool observations necessarily differ. The baseline has no catalog verification or audience measurements. Each plan position compares the replacement, promoted act and plan type; changed choices and missing counterparts are highlighted. An agreement is shown honestly and does not validate the guess. This exposes the evidence difference and makes a live model comparison inspectable; it does not establish measured superiority.

With the deterministic planner enabled, the baseline follows phone-list order. That is an offline demonstration of the comparison interface, not an experiment on a live LLM.

## Two-minute walkthrough

1. Review the stage timelines, struck-through cancelled slot and eligible/excluded phone-list cards. Expand **Edit scenario & phone list** to change the inputs.
2. Run **Rescue with Qloo**. In mock mode, choose a catalog option for `Sample Twin Lantern` and use **Apply choices & re-run**. Other resolved candidates can support plans while this choice is pending.
3. Inspect the direct swaps and promotion/backfill option. The three labelled evidence meters distinguish the cancelled audience, remaining lineup and local heat.
4. Use **Compare with LLM-only**. Inspect matching/different choices in the two columns. On phones the columns stack. The control explicitly has no audience evidence.
5. Expand announcement drafts, refund checklists and the trace. To exercise a missing entry in mock mode, change an eligible name to `Sample Unknown Act`; it will not be scored.

The dark operations desk uses system fonts, CSS only, native buttons/choices/drawers, visible keyboard focus and reduced-motion support. It fetches no runtime images or fonts. Progress labels are a time-based guide while the request is pending, not streamed server observations. Buttons and scenario inputs are disabled during runs. Recovery advice distinguishes invalid input, connection loss and provider/server failures. Model usage limits return fixed-rule plans instead of refusing a run.

## Architecture and setup

Next.js App Router + strict TypeScript + React on the **Node runtime**. The route invokes a bounded manual Anthropic tool loop; the Qloo client and private caches stay server-only. There is no database, hosted storage, Edge dependency or UI framework. [docs/SPEC.md](docs/SPEC.md) defines the request/response contract.

From a clean clone, use **Node 22** and npm:

```sh
npm ci
npm run dev
```

Open `http://localhost:3000`. No keys or environment file are required for the complete synthetic demo. Direct dependencies are pinned and the lockfile fixes the tree. Next.js telemetry is disabled by the npm scripts.

For production:

```sh
npm run build
npm start
```

Provide credentials through the host's secret manager or process environment, never through the browser or committed files. `.env.example` documents variable names; creating an environment file is optional and unnecessary for mock mode.

| Variable | Behaviour |
| --- | --- |
| `QLOO_API_KEY` | Server-only credential. If absent, Qloo is mock even when `QLOO_MODE=live`. |
| `QLOO_BASE_URL` | Default `https://hackathon.api.qloo.com`; HTTPS only, no embedded credentials. |
| `QLOO_MODE` | `mock` forces synthetic data; otherwise a supplied key selects live Qloo. |
| `ANTHROPIC_API_KEY` | Server-only credential. If absent, the planner is deterministic. |
| `LLM_MODE` | `mock` forces the deterministic planner; otherwise a supplied key selects the live model. |
| `LLM_RUNS_PER_IP` | Optional positive integer; defaults in code to 20 live model runs per hashed IP per ten-minute window. Invalid or empty values use the default. |
| `LLM_RUNS_PER_DAY` | Optional positive integer; defaults in code to 1,500 live model runs per UTC day, counted in each server instance's memory. Invalid or empty values use the default. |
| `QLOO_MAX_PER_SECOND` | Optional positive integer; defaults to 8 HTTP requests started in any rolling 1,000 ms and at most 8 in flight, shared by all live clients per server instance. Invalid or empty values use the default. |
| `QLOO_CALLS_PER_DAY` | Optional positive integer; defaults to 2,000 HTTP requests actually sent to Qloo per UTC day, per instance. Retries count; cache hits and mock mode do not. Invalid or empty values use the default. |
| `QLOO_RUNS_PER_IP` | Optional positive integer; defaults to 10 runs that would touch live Qloo per hashed client key per ten-minute window, per instance. Invalid or empty values use the default. |
| `QLOO_RUNS_PER_IP_DAY` | Optional positive integer; defaults to 40 runs that would touch live Qloo per hashed client key per UTC day, per instance. Invalid or empty values use the default. |

Modes are independent. `GET /api/status` returns only `{ "qloo": "live" | "mock", "llm": "live" | "mock" }` with `Cache-Control: no-store`; it reports configuration, not a provider health check. The page initializes from the same server status and refreshes it through that endpoint. `samples/scenario.json` supplies fictional Bristol acts in mock mode. Live Qloo mode selects `samples/scenario.live.json`: an invented Austin, TX festival featuring public artist names. Fictional scenario for demonstration. Artist names are used only to look up public taste data; no real cancellation or booking is implied. All logistics, availability, holds and commitments in that sample are fictional; no bookings or tour dates are asserted.

The live loop uses the non-beta Anthropic SDK `client.messages.create`, `claude-haiku-5-5`, `output_config: { effort: "medium" }`, `max_tokens: 16000`, strict closed tool schemas and a target of at most three turns: one parallel data batch, at most one dependent follow-up batch, then submission. An eight-turn safety limit permits corrections and stop handling. The initial message supplies final resolved IDs; the model cannot repair ambiguous or missing catalog matches. Submission contains only plans (up to 3; rationale up to 600 characters; up to 4 caveats of 200 characters each), announcement (280/120/1200 characters for post/subject/body) and ticket checklists (up to 6 items of 200 characters each). Invalid decisions return specific errors with the offending plan ID, or null for submission-wide errors. Full assistant content, including thinking/signatures, is preserved between turns. `end_turn` gets one submission reminder; pause continues; refusal, exhaustion or provider errors switch to the explicitly labelled fixed-rule planner while preserving the evidence source. Model/account support still requires live verification.

## Limits and abuse protection

- Input validation: one cancelled act, up to 12 candidates, 20 lineup acts, 12 ticket types and 200 characters per input text field; unique act names, real date format, bounded travel duration and a 64 KiB request body. Invalid or oversized requests return HTTP 400. Notes cannot expand the permitted entity or city set.
- Live-model limits: 20 runs per hashed client IP per ten-minute window and 1,500 runs per UTC day per server instance by default, configurable with `LLM_RUNS_PER_IP` and `LLM_RUNS_PER_DAY`. At either limit, valid requests still return HTTP 200 with fixed-rule plans using the same Qloo evidence and `llm: "fallback"`; no model call is made. Baseline fallback uses the same scenario and hard constraints without Qloo. Disclaimers distinguish the per-IP or daily limit from a model time-budget fallback, and the trace records `ip_limit`, `daily_cap` or `deadline` respectively. Usage-limit fallbacks are never cached.
- Every run that sends at least one model request consumes both model counters, including success, fallback, refusal, output limit, unfinished work, provider error, deadline and client abort. Slots are reserved atomically immediately before model work and released only when no model request was sent (including cancellation before the first send). Cache hits, shared identical requests, deterministic mock runs and limit fallbacks that never send do not consume model slots. A comparison may use two live runs. Failed model attempts may incur provider charges; these counters are not a monetary spending guarantee.
- Measured hackathon Qloo quota: response headers report 10 requests/second and 50,000 requests/month; the monthly window covers the judging period. A 15-request parallel search probe returned ten HTTP 200s and five HTTP 429s. The 8-act live sample used about 17 Qloo requests (HTTP 200 in 20.1 seconds, 13 trace rows, no errors). These observations inform the per-instance defaults; workload and cache state can change the call count.
- Qloo rate gate: all live requests, including retries and requests from concurrent runs, share a FIFO queue per instance. At most `QLOO_MAX_PER_SECOND` requests start in any rolling 1,000 ms, with the same limit in flight (default 8). Queued requests honour cancellation and are never sent after being aborted.
- Daily Qloo request budget: `QLOO_CALLS_PER_DAY` defaults to 2,000 actual HTTP requests per UTC day, per instance. Every sent attempt counts, including retries and failed requests. Result-cache hits, response-cache hits and mock mode do not consume it. Admission checks before `resolve_acts` use the same `qloo_limit` path as the live-Qloo brake when the budget is reached: HTTP 200, fixed rules, no Qloo or model call and no result caching. The disclaimer says: "Audience data was not fetched because this server reached its daily Qloo request budget. These plans use fixed rules only." The trace records `reason: "qloo_limit"` and `sub_reason: "daily_budget"`. An already admitted run may finish even if it crosses the budget.
- Live-Qloo brake: checked before `resolve_acts`, with defaults of 10 runs per hashed client key per ten minutes and 40 per hashed client key per UTC day, per instance. `QLOO_RUNS_PER_IP` and `QLOO_RUNS_PER_IP_DAY` configure these limits. The brake counts runs, not individual Qloo calls, including Qloo work for the fixed-rule planner after a model limit. Result-cache hits, shared in-flight runs, baseline requests and mock-Qloo mode do not consume Qloo slots. Failed or cancelled live-Qloo runs stay counted. At either limit it never refuses the request: HTTP 200, `llm: "fallback"`, trace reason `qloo_limit` with `sub_reason: "client"`, no Qloo or model calls, and baseline fixed-rule evidence "Fixed-rule suggestion; no audience data." The requested response mode is preserved. The disclaimer says: "Audience data was not fetched because of high request volume from this address. These plans use fixed rules only." These responses are never cached.
- Both limiters use the same hashed client key: IPv4 hashes are unchanged; IPv6 addresses are grouped and hashed by their canonical /64 prefix. Each limiter table holds at most 10,000 keys. When full, it evicts the oldest inserted entry and admits the new key instead of locking out new visitors. Eviction also discards that key's retained counts.
- Proxy requirement: replace `X-Forwarded-For` with the trusted client address. Accepting arbitrary forwarded headers permits bypassing the IP limit. Without that header, requests share one bucket.
- Private memory-only caches: 500 provider responses and 100 completed scenarios, bounded LRU with a 24-hour TTL. Keys include endpoint/parameters or normalized scenario, mode, sources and resolutions. Next's HTTP cache is bypassed; API results are `no-store`.
- Qloo: 15-second timeout per HTTP attempt, starting after the queue. On HTTP 429, wait for the numeric `x-second-ratelimit-reset` in seconds (default 1 for missing/invalid values, clamped to 1–5 seconds), then retry at most twice. HTTP 5xx keeps one retry after 300 ms. All retry waits honour cancellation and all retry attempts pass through the gate. Provider errors omit raw response bodies. No automatic fallback or undocumented endpoint is tried.
- Each rescue has a 50-second deadline, including body reading. Identical concurrent requests share a run that continues while any waiting client remains connected. Each disconnected client stops waiting independently. The shared run aborts when all waiting clients disconnect or the original 50-second deadline is reached; later clients do not extend it. `maxDuration=60` documents the hosting budget. Live model work has a 40-second budget; timeout, provider error, refusal, output limit or unfinished work switches to the fixed-rule planner using the same scenario, hard filters and Qloo evidence. These responses say `llm: "fallback"`, retain model timings, show a calm notice and are not cached as scenario results. Qloo pre-resolution failures still return HTTP 502 with error code `provider`, the collected trace and the message "Qloo could not be reached for this run. Please try again in a minute." Synthetic data never replaces live Qloo. Comparing two sequential runs can take up to roughly 100 seconds. Input values remain available after a failure.
- Limits and caches reset on restart and are not shared across instances. On a serverless host each instance keeps its own counters and cache, so the daily limit applies per instance and a repeated scenario is not guaranteed to hit the cache. They are not a distributed or account-wide spending ceiling; the hard ceiling is the model account's own credit balance or spend limit, and a failed model call (including an exhausted balance) falls back to fixed-rule plans.

## Data handling

Only public act names, entity IDs and the city go to Qloo. No personal data is requested or sent to Qloo. Festival names, dates, stage/times, ticket types and booker notes are excluded from Qloo calls. Notes and scenario details go to Anthropic only when the live language model is enabled; users must not enter personal data in them.

Live Qloo responses are cached in **private server-side memory only**. They are never written to files, fixtures or the repository. With the live planner enabled, bounded Qloo tool results also enter Anthropic's context to draft supported plans. Scenario inputs/results expire with cache eviction, TTL or process restart. The client holds only the displayed run and edits; it does not persist them to local storage. Server logs contain counts/timings only. There is no app analytics. Fixture artists, IDs and affinities are hand-written synthetic data, protected by a UUID-shape guard.

Inputs, provider output and model text are untrusted data. Tool validation limits requests to eligible scenario entities and the city. The server rejects invalid replacements/promotion paths and overwrites model evidence. React renders output as text; the app does not execute model instructions or publish drafts.

## Known limitations

- Qloo provides **aggregate taste evidence only**, not individual preferences or causal effects. Lineup Rescue does not predict availability, fees or ticket sales. Those remain organiser decisions and checks.
- Catalog coverage of smaller acts may be limited. Ambiguous and missing entries reduce the supported plan set; empty results do not establish zero fit. An unrecognized cancelled act can prevent any grounded plan.
- Provider response parsing accepts documented kit-shaped variants (`results` arrays or nested entities/heatmap/tags, `entity_id`/`id`, and affinity or `query.affinity`). Missing/invalid affinity stays unknown. Search 404 means no catalog match. Offline tests do not verify live response shapes, city interpretation, latency or credentials; the measured live sample above is a separate observation.
- The supplied artist parameter table and deeper reference differ on `signal.location.query`. This follows the specification's request shape. Live validation is still necessary; unsupported parameters are not silently replaced.
- A promotion plan still needs set-length, rider, contracts, fees and changeover verification. Announcement text is a draft. Refund checklists ask what to verify under published ticket terms, rather than deciding policy or legal entitlement.
- No user counts, accuracy estimates, testimonials or measured superiority are claimed. Synthetic results exercise behaviour; they do not validate real-world ranking quality.

## Submission checklist

1. **Problem and user:** the opening sections identify the cancelled-slot decision and the festival staff responsible.
2. **Qloo's role:** the workflow and endpoint table show how identity, two-audience rankings and regional context support that decision.
3. **Inspectability:** the synthetic worked path and expandable trace connect selected entities and request parameters to the resulting plans, with IDs shortened.
4. **Demonstration:** the hosted demo at https://lineup-rescue.vercel.app runs on live Qloo data without a login; submission screenshots are taken there and show no credentials or personal data. The local walkthrough runs without credentials on synthetic data.
5. **Reproduction:** clean-install commands, configuration and offline checks appear here and in the lockfile.
6. **Boundaries:** the limitations above distinguish taste evidence, operational assumptions and conclusions the tool cannot support.

## Verification

```sh
npm run lint
npm test
npm run build
npm run smoke
```

Tests cover serialization, parsing, retries/timeouts, caches, feasibility, ambiguous/missing acts, plan assembly, strict tool schemas, model-loop stop handling, usage-limit fallbacks, counter accounting, environment overrides, comparison diffing, status configurations and the inline-resolution rerun payload. Server-rendered UI checks cover sample selection, the live-sample notice, choices, provenance and honest meters. Tests/smoke force mock modes, clear inherited credentials and block provider network calls; transport tests inject local synthetic responses. Smoke exercises the actual route in both `qloo` and `baseline` modes. Live service behaviour requires separate authorised validation.

## Licence

MIT, copyright © 2026 Dried Sandwich. See [LICENSE](LICENSE). Qloo data and credentials are not distributed under the source licence.
