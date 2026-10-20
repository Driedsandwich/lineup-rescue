# Encore Rescue

A headliner cancels. The booker already has a short list of acts who can make it. Encore Rescue helps compare that feasible list against the cancelled act's audience and the remaining lineup, then prepares a running-order proposal, announcement drafts and a refund-handling checklist.

This is a hackathon decision-support prototype. It does not book acts, send messages, set refund policy, predict ticket sales or determine fees or availability.

## Run from a clean checkout

Use **Node 22** and npm. All direct dependencies are pinned; `package-lock.json` fixes the dependency tree.

```sh
npm install
npm run dev
```

Visit `http://localhost:3000`. With no credentials the whole application works locally using synthetic Qloo data and a deterministic sample planner. No environment file is required. Next.js telemetry is disabled by the scripts.

For a portable production server:

```sh
npm run build
npm start
```

The app uses the Next.js App Router, strict TypeScript and the Node runtime. It needs no hosted database, platform storage, Edge runtime or external fonts. npm's cache stays in the ignored `.cache/npm` directory.

## Two-minute demo

1. Keep the preloaded fictional festival in Bristol, UK. Review the stage/time slots and the booker's phone list. All sample act names start with **Sample**.
2. Click **Rescue with Qloo**. Two acts fail the hard constraints. `Sample Twin Lantern` deliberately has two synthetic catalog matches; choose one and re-run. Other eligible acts can still support plans while this choice is pending.
3. Inspect direct swaps and the promote-and-fill plan, including the freed slot, both audience comparisons and regional evidence. The announcement is an editable draft and makes no unconfirmed booking claim.
4. Click **LLM only (no Qloo)**. Results remain side by side, with the ranking difference highlighted. The deterministic baseline uses phone-list order and explicitly labels its suggestions as ungrounded.
5. Expand the tool trace for a redacted request-to-result explanation. To demonstrate a missing catalog entry, edit a name to another fictional sample name: it will not be scored or guessed. Edits clear earlier results to prevent comparing different scenarios.

## How Qloo changes the decision

Hard constraints are applied in ordinary code **before** the agent: unavailable acts, inability to arrive within 48 hours with crew/gear, or recorded travel exceeding 48 hours exclude an act. Missing travel time alone does not exclude an otherwise confirmed act. Availability is booker input, not a prediction.

Only allowed act names are resolved through `GET /search` with `types=urn:entity:artist`. An exact unique name match is accepted; ambiguous or non-exact results require a choice. A supplied choice is checked against the search options again. No match is shown as **not in the Qloo catalog**, never given an invented ID or score. Hard-excluded acts are never sent to Qloo.

`rank_against_audience` uses `GET /v2/insights` with `filter.type=urn:entity:artist`, `filter.results.entities` for the fixed feasible options, `signal.interests.entities` for the cancelled act or lineup, and `signal.location.query` for the city. `local_heat` uses `filter.type=urn:heatmap`, the act ID as the interest signal, and `filter.location.query` for the city/region. Ranking a lineup act against the cancelled act and a candidate against the promoted act supports the promote-and-fill path.

Each tool call records its name, bounded/redacted parameters, status, result count and latency. For example, the synthetic trace ranks the resolved phone-list IDs against the resolved cancelled-act ID in Bristol, compares them with the lineup, then checks local heat. IDs are shortened to eight characters in traces; actual selection options retain their IDs so a user can disambiguate them. No provider response is logged.

The server validates submitted replacements and promotions and replaces model-written evidence with the actual observed affinity/heat results. Missing evidence remains unknown. Affinity is not presented as a ticket-buying probability. The live agent receives the same system instructions and scenario in both modes; baseline removes all three Qloo tools and retains `submit_rescue_plan`.

## Configuration

Inject variables using your host's secret manager or process environment. `.env.example` documents names and the default URL; do not commit credentials or put them in browser code.

| Variable | Meaning |
| --- | --- |
| `QLOO_API_KEY` | Server-only Qloo hackathon credential; absent means mock mode. |
| `QLOO_BASE_URL` | Defaults to `https://hackathon.api.qloo.com`; must be HTTPS. |
| `QLOO_MODE` | `mock` forces synthetic data even if a key exists; otherwise a supplied key selects live Qloo. |
| `ANTHROPIC_API_KEY` | Server-only Anthropic credential; absent means deterministic planner. |
| `LLM_MODE` | `mock` forces the deterministic planner; otherwise a supplied key selects the live agent. |

The two modes are independent: the deterministic planner can exercise live Qloo, or the live language model can use synthetic Qloo. The UI shows both source states. **Sample data** identifies synthetic taste evidence; **Planner: mock** identifies templated planning. A live provider failure never silently switches to synthetic data or a different model.

Live Anthropic execution uses the non-beta TypeScript SDK's `client.messages.create`, `claude-haiku-5-5`, `output_config: { effort: "medium" }`, `max_tokens: 16000`, strict closed JSON-schema tools and automatic tool choice. Every complete assistant content array, including thinking blocks/signatures, is appended unchanged. The agent gets at most eight turns and a 50-second request deadline, with clear errors on refusal or token exhaustion, one submission reminder after `end_turn`, and continuation after `pause_turn`. Model/account availability is not verified by the offline tests.

## API and safeguards

`POST /api/rescue` accepts `{ mode, scenario, resolutions? }` and returns the full contract in [docs/SPEC.md](docs/SPEC.md). `samples/scenario.json` supplies the initial scenario object. Both modes end through the same validated `submit_rescue_plan` implementation.

- Zod validates the full input: at most 12 candidates, 20 lineup acts and 200 characters per text field, real date format, booleans, bounded nonnegative travel duration and unique act names. Ticket types are limited to 12; total JSON body to 64 KiB.
- Per-IP limit: 5 requests in a 10-minute fixed window, including cache hits. IPs are hashed in memory and never logged. Behind a proxy, configure it to **replace** `X-Forwarded-For` with the trusted client address; untrusted forwarded headers can bypass an IP limit. Requests without that header share the `unknown` bucket.
- Global cap: 300 uncached sessions per UTC day in the running process. Concurrent identical scenarios share one session. Input normalisation, mode/source state, city and resolution choices participate in the result-cache hash; both cache hits and shared sessions avoid another model call.
- Two private, bounded LRU caches use a 24-hour TTL: provider responses (500 entries, keyed by endpoint and sorted parameters) and completed scenarios (100 entries). Both are **memory only**. Next's HTTP/data cache is bypassed for Qloo and result responses are `no-store`.
- Each Qloo request uses GET, comma-joined arrays, `X-Api-Key`, a 15-second timeout and one 300 ms-backoff retry on 429/5xx only. Network/auth/parse errors are typed; errors contain no provider response body. Request cancellation/deadline aborts outstanding calls.
- `maxDuration = 60` documents the hosting budget; the route also implements its own 50-second deadline, including request-body reads. This works on ordinary Node 22 hosts without platform features.

## Data handling

Only act names, entity IDs and the city are sent to Qloo. Festival name, date, stage/time details, ticket types and booker notes are **not** sent to Qloo. Notes and scenario details go to Anthropic only when the live language model is enabled. Users are asked not to enter personal data. Fixtures contain fictional acts, fake `mock-artist-…` IDs and deterministic pseudo-affinity. They were handwritten; no live response was recorded.

Live Qloo responses are never written to files or fixtures. Scenario inputs and results are retained only in private process memory until cache eviction, expiry or restart. Server logs contain counts and timings only. No analytics or app telemetry is included. Untrusted notes, provider results and model output cannot expand the allowed entity/city set, bypass constraints or execute code.

## Verification

```sh
npm run lint
npm test
npm run build
npm run smoke
```

Vitest covers query serialization, response variants, retries/timeouts, LRU expiry/eviction, hard constraints, catalog ambiguity/missing entries, plan assembly, baseline isolation, strict tool schemas, manual model-loop stop handling, input limits, rate limits, API caching and the 50-second deadline. A recursive fixture guard rejects UUID-shaped strings. The real `server-only` package rejects Qloo imports in the client condition; a source import-graph guard also keeps server modules and credentials out of the client component graph. Production compilation checks the Next.js boundary.

Tests and smoke explicitly force both mock modes, clear inherited credentials and replace global `fetch` with a function that throws. Qloo HTTP tests inject local fake transports; no test calls Qloo or Anthropic. Smoke calls the actual route handler in both modes, validates every response key and plan/checklist/trace structure, and verifies zero network calls.

## Assumptions and limits

- Response items are incompletely specified in the supplied public Qloo reference. The parser accepts `results` arrays or `results.entities`, `results.heatmap` and `results.tags`; entity IDs may be `entity_id` or `id`, and affinity may be top-level or `query.affinity`. Missing/invalid affinity stays unknown. Heat labels use location name/geohash when available, otherwise an unnamed area. Search 404 is treated as no match. Verify these assumptions on the first authorised live call.
- The supplied entity-type table omits `signal.location.query` from its artist list, while the deep dive and kit shapes describe it. This implementation follows SPEC §6 and the kit-shaped request. Empty live results may indicate unsupported parameters or no data; they do not establish zero fit. No alternate undocumented endpoint is tried.
- All included verification is offline. Live Qloo shapes, credential access, city matching, latency and the required Anthropic model/effort support remain unverified. No live requests or credential files were created in this batch.
- The deterministic planner is a demonstration, not an evaluation of a live model. A baseline guess can agree with Qloo by chance. Neither route infers real availability, contracts, fees, individual behaviour or ticket sales.
- In-process limits and caches reset on restart and are not coordinated across multiple server instances. Use a single process for this bounded hackathon demo; a multi-instance public deployment needs shared controls before treating these limits as an account-wide spend ceiling. Long live runs may time out rather than returning partial unsupported plans.
- The announcement remains a draft. Refund checklist items are decisions/verification tasks, not legal advice or an invented refund entitlement. Promotion still needs set-length and production confirmation.
- Batch 1 provides accessible basic styling and working controls; visual polish is reserved for batch 2.

## Licence

MIT, copyright © 2026 Dried Sandwich. See [LICENSE](LICENSE). Qloo provider data and credentials are not licensed or distributed with this source code.
