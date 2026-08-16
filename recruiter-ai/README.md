# agent_max

An **autonomous, field-agnostic candidate sourcing and ranking agent**. Give it a job field
(software, healthcare, sales, finance, design, …), weighted requirements, and how many
candidates you want back — the agent decides on its own which of 16 real data sources to query,
runs them in parallel, merges and deduplicates what comes back, and returns **one consolidated
ranked report**, each candidate rated 1–10 with visible provenance and confidence. There is no
data-source picker; source selection is the agent's job.

> This is decision-support, not an autonomous filter. Read [FAIRNESS.md](./FAIRNESS.md)
> before using scores to inform a real hiring decision — it documents, plainly, where the
> ranking heuristics are invented, where dedupe deliberately under-merges, why LinkedIn/Unstop
> are permanently out of scope, and a real case where the open-web agent attached a genuine
> person's name to a page they don't appear on.

## Quick start

Requires Node.js >= 18 (uses the built-in `fetch` and `node:test`). **Zero new npm
dependencies beyond `dotenv` and `express`** — every source integration and the MCP server are
hand-rolled against those two plus Node built-ins.

```bash
npm install
node server.js
```

Open http://localhost:3000.

### Optional environment variables

Copy `.env.example` to `.env` and fill in what you need — everything is optional. With zero
configuration the agent still runs (`upload` always works, and any registry/API provider that
needs no key still gets queried), it just reaches fewer sources.

| Variable                | Purpose                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`           | Raises the GitHub provider's rate limit from 60 req/hr to 5000 req/hr. Create one at https://github.com/settings/tokens (no scopes needed — only public data is read). Without it, the `github` provider still works, just slower. |
| `GOOGLE_PLACES_API_KEY`  | Enables the `google_places` provider — real local businesses/professionals for **any field, any city**, via Google's Places API (New) Text Search. Requires a Google Cloud project with billing enabled; the free monthly credit covers normal use. Without it, the provider silently returns no results. |
| `ANTHROPIC_API_KEY`      | Enables LLM-backed candidate reasoning/scoring and LLM source-refinement, routed through Claude (`claude-sonnet-5`). |
| `GROQ_API_KEY`           | Same LLM capability, routed through Groq's free tier (`llama-3.3-70b-versatile`) instead of Claude. Get a free key at https://console.groq.com. Note: Groq's free tier has aggressive rate limits and can return `429` under repeated testing — that's throttling, not a bug. |
| `GEMINI_API_KEY`         | Same LLM capability, routed through Google's free tier (`gemini-2.0-flash`) instead of Claude. Get a free key at https://aistudio.google.com. |
| `LLM_PROVIDER`           | Optional override when multiple LLM keys are set: `anthropic`, `groq`, or `gemini`. Default priority without it: Anthropic > Groq > Gemini. |
| `TAVILY_API_KEY`         | Enables the `open_web` provider's search step — an AI agent that searches the open web and reads pages on its own to find candidates for any field/city. Needs **both** this key and one LLM key above. Free, no card — sign up at https://tavily.com. Without it, `open_web` silently returns no results (never crashes a search). |
| `PORT`                   | Server port. Defaults to `3000`.                                                                  |

Only **one** of `ANTHROPIC_API_KEY` / `GROQ_API_KEY` / `GEMINI_API_KEY` is needed to enable LLM
scoring and source refinement — Groq and Gemini both offer free keys. Without any of them,
every search silently and automatically falls back to the deterministic rules-based scorer
(`lib/scoring/rules.js`) and the deterministic source-selection map (`lib/agent/plan.js`) —
nothing breaks, the agent just makes its calls without an LLM in the loop.

## The autonomous agent-search flow

This is the primary way to use the app (both the web UI and the MCP tool drive it). Give the
agent a `jobSpec` (field, title, location, weighted criteria) and how many candidates you want
(`topN`), and it does the rest:

```
jobSpec + topN
      │
      ▼
lib/agent/plan.js          selectSources() — deterministic field→sources baseline, availability-
                            checked, plus an optional LLM add/skip pass (capped, validated,
                            never able to influence scores/ordering)
      │
      ▼
lib/agent/orchestrate.js   Promise.allSettled fan-out across ≤5 sources, per-source 20s timeout,
                            60s global deadline — never throws, a slow/failing source just
                            contributes zero candidates and is reported in sourcesQueried
      │
      ▼
lib/agent/dedupe.js        three-tier merge: auto-merge on identical sourceUrl (silent) →
                            corroborated name+signal merge (flagged, mergedFrom) → flag-only
                            (possibleDuplicateOf, never merged) — biased hard toward
                            under-merging (PLAN_V2.md §4 P3, FAIRNESS.md §10)
      │
      ▼
lib/scoring/rules.js        totalScore / rank1to10 — UNCHANGED, frozen contract
  or lib/scoring/llm.js
      │
      ▼
lib/agent/consolidate.js    dataCompleteness, adjustedScore, sourceTrust, rankingScore,
                            agentRank1to10 — makes wildly different data richness comparable
                            in ONE ranked list (PLAN_V2.md §4 P2, FAIRNESS.md §10)
      │
      ▼
ONE ranked report: { candidates[], totalFound, matched, scoredBy, sourcePlan[], agentLog,
                      sourcesQueried[] }
```

There are **two front doors** onto this exact same pipeline, plus an MCP server — no logic is
duplicated between them:

- **`POST /api/agent-search`** — blocking; holds the request open until the search finishes
  (fine for fast searches, but a long `open_web`-inclusive run can approach the 60s global
  deadline and read as a hung request).
- **`POST /api/agent-search/jobs` + `GET /api/agent-search/jobs/:jobId`** — async job + polling.
  Returns a `jobId` immediately; poll the `GET` endpoint to watch `progress.sourcesDone` /
  `progress.sourcesTotal` climb in real time as each source finishes, then read `result` once
  `status` is `"done"`. This is what the web UI uses, and it's the one to prefer for anything
  that might include `open_web`.
- **The MCP server (`mcp-server.js`)** — a third, conversational front door. See
  [docs/MCP.md](./docs/MCP.md) for the full protocol reference; the short version is in
  [API reference](#mcp-server) below.

### The 16 data sources

The agent chooses among these; there is no picker. `lib/agent/plan.js` builds a deterministic
baseline per field (extending `defaultProviderForField`), and — only when an LLM key is
configured — one bounded, validated LLM call may add or skip sources on top of that baseline
(capped at 5 total sources, output checked against `listProviders()`, hallucinated keys
dropped, and structurally forbidden from influencing scores or ranking order).

| Provider | Trust tier | What it is |
| --- | --- | --- |
| `sebi_ria` | verified | Official SEBI Registered Investment Adviser registry (India) — bundled periodic snapshot |
| `nmc` | verified | Official National Medical Commission doctor registry (India) — live query |
| `npi` | verified | Official NPI Registry (US CMS) — live query |
| `finra` | verified | FINRA BrokerCheck (US regulator) — live query |
| `upload` | verified | Recruiter-supplied CSV/JSON — always merges into the pool, never a separate mode |
| `github` | profile | Real GitHub user search + profile data |
| `stackoverflow` | profile | Real top answerers via the Stack Exchange API |
| `hn_hiring` | profile | Hacker News "Who's Hiring" thread parsing |
| `devto` | profile | Dev.to author search |
| `huggingface` | profile | Hugging Face user search |
| `orcid` | profile | ORCID researcher registry |
| `openalex` | profile | OpenAlex researcher/publication data |
| `google_places` | profile | Google Places Text Search — real local businesses/professionals, any field/city (needs a paid-tier key) |
| `osm` | lead | OpenStreetMap Overpass API — free, no key, best-effort coverage/uptime |
| `open_web` | lead | An LLM in a multi-turn tool-calling loop that searches (Tavily) and reads pages on its own — see below |
| `sample` | lead | Synthetic demo data — **excluded from agent-search entirely**, see below |

Full per-tier definition, and why trust and data-completeness are tracked as separate axes, is
in `lib/agent/trust.js`, `lib/agent/consolidate.js`, and FAIRNESS.md §10.

**`sample` is deliberately excluded from autonomous search.** Fabricated demo people must never
be silently blended into a report presented as real; fields with no real provider and no keys
configured (sales, marketing, design, operations without a Google Places/Tavily key) can
honestly return zero candidates rather than fake ones.

**On `open_web`:** every other provider runs one fixed, deterministic query. This one is
genuinely agentic — the LLM decides how many searches to run, which pages to read, and when it
has enough, sweeping across different kinds of public surfaces (portfolios, directories,
speaker pages, company team pages, freelancer listings) rather than firing one generic query.
Inside agent-search it runs on a **shrunk budget** (`maxTurns: 3` vs. up to 10 standalone) so
fan-out latency stays bounded. It needs both an LLM key and `TAVILY_API_KEY`; without both it
returns no results, never crashes the search. Its output goes through a **structural anti-
fabrication grounding gate** before ever reaching the scorer: every candidate name is checked
against the literal text of every page the agent actually read that run, and a name that
doesn't demonstrably appear is dropped — this exists because prompt instructions alone did not
reliably stop the model from inventing a name (once) or, worse, recalling a real, unrelated
person from its training data and attaching them to a page they don't appear on (once) under
pressure to fill the required `name` field. See FAIRNESS.md §9 for the full incident record —
**manual click-through on every `open_web` lead remains mandatory regardless.**

## Response fields

Every candidate object returned by `/api/agent-search` (and its job/polling counterpart)
carries the original scoring fields plus new consolidation fields:

| Field | Meaning |
| --- | --- |
| `totalScore`, `rank1to10` | **Frozen, unchanged** — the same weighted rules/LLM scoring math as `/api/search`, over the full criteria set as written. |
| `dataCompleteness` (0–1) | How much of the jobSpec this candidate's source could actually speak to (weight-fraction of criteria with real data) — not string-matched against scorer note text. |
| `adjustedScore` | The same weighted math as `totalScore`, but restricted to the denominator of criteria the source could answer, so a thin-but-real candidate isn't punished for silent "no data" zeros. |
| `sourceTrust` | `"verified"` \| `"profile"` \| `"lead"` — a per-source prior (`lib/agent/trust.js`). Orthogonal to completeness: an `open_web` hit can be highly complete and still be `lead`-tier unverified. |
| `rankingScore` | `adjustedScore × completenessDamp(dataCompleteness) × trustFactor[sourceTrust]` — the actual sort key for the consolidated list. Constants live in `CONSOLIDATION_WEIGHTS` (`lib/agent/consolidate.js`) and are **invented heuristics, not empirically derived** — see FAIRNESS.md §10. |
| `agentRank1to10` | 1–10 derived from `rankingScore`, shown to the recruiter as the primary rating; `rank1to10`/`totalScore` remain visible on the card too. |
| `provenance` | `[{ source, sourceUrl }]` for every record folded into this one by dedupe — always present, even for a candidate that wasn't merged with anything (a one-element array in that case). |
| `mergedFrom` | Present only on a tier-2 corroborated merge — the original candidate `id`s that were combined, so the merge is auditable by eye. |
| `possibleDuplicateOf` | Present only on a tier-3 flagged (never-merged) row — the `id` of the stronger row this one might be the same person as. Both rows are kept; the recruiter decides. |

Top-level response fields (both endpoints): `candidates`, `totalFound`, `matched`, `scoredBy`,
`sourcePlan` (`[{ providerKey, reason }]` — what the agent chose to query and why),
`sourcesQueried` (`[{ key, count, ms, status }]` — what actually happened per source), and
`agentLog` — a single newline-joined **string** (not an array) narrating the whole run for the
methodology panel.

## Features

- **Any job field** — not just tech. Ships with software, healthcare, sales, finance, and
  design templates; add more by editing `lib/jobTemplates.js` and (optionally) a sample
  dataset.
- **Job-template library** — pre-filled weighted criteria for common roles per field, used to
  seed the criteria form (`GET /api/templates`).
- **Weighted, transparent scoring** — every candidate shows a per-criterion `raw` fit (0–1),
  `weighted` contribution, `max` possible, and a human-readable `note` explaining the
  judgment, plus an overall `totalScore` (0–100) and `rank1to10` (1–10), and (in agent-search)
  the consolidation fields above.
- **No source picker** — the agent decides what to query. The frontend exposes an `N`
  candidates control (clamped 1–50, default 10) and a collapsed CSV/JSON upload section that
  always merges into the agent's search pool.
- **Live progress** — the job/polling endpoint pair reports `progress.sourcesDone` /
  `progress.sourcesTotal` as each source finishes, so a long `open_web`-inclusive search shows
  real incremental feedback instead of a blank spinner.
- **Group by confidence toggle** — default view is one consolidated ranked list; a toolbar
  toggle switches to sections grouped by `sourceTrust` for recruiters who want the harder
  separation.
- **Trust badge + completeness bar per card** — every result visibly shows its `sourceTrust`
  tier and `dataCompleteness` percentage, so the ranking is never a black box.
- **Methodology panel** — renders `sourcePlan`, `sourcesQueried`, and the `agentLog` narrative
  for the run that produced the list on screen.
- **Optional LLM reasoning** — when an LLM key is set, scoring can route through it for a
  natural-language per-candidate justification (`lib/scoring/llm.js`), with the same weight
  math applied locally so LLM and rules scores stay directly comparable. Falls back to rules
  scoring on any failure — search never breaks because of the LLM path.
- **MCP front door** — `mcp-server.js` exposes the same pipeline as MCP tools over stdio for
  chat-driven use from Claude Desktop or Claude Code. See [docs/MCP.md](./docs/MCP.md).
- **Recruiter workflow** — shortlist candidates, compare side by side, export results,
  search history, saved searches, and shareable read-only result links (`POST /api/results` /
  `GET /api/results/:id`).

## API reference

All endpoints are under `/api`. Errors use an opaque, coded shape —
`{ "error": "<generic message> (Rxxx)" }` — see [docs/ERROR_CODES.md](./docs/ERROR_CODES.md)
for what each code actually means.

### `GET /api/health`

```json
{ "ok": true, "githubAuth": false, "googlePlacesAvailable": false, "openWebAvailable": false, "llmAvailable": false, "llmProvider": null }
```

`llmProvider` is `"anthropic" | "groq" | "gemini" | null` — whichever backend is active per
the `ANTHROPIC_API_KEY` / `GROQ_API_KEY` / `GEMINI_API_KEY` / `LLM_PROVIDER` env vars.
`openWebAvailable` is `true` only when both an LLM key and `TAVILY_API_KEY` are configured.

### `GET /api/fields`

Fields derived from registered providers + job templates, and which of the 16 providers serve
each.

```json
[
  { "key": "software", "label": "Software", "providers": ["github", "stackoverflow", "hn_hiring", "devto", "huggingface", "sample", "upload", "google_places", "osm", "open_web"] },
  { "key": "finance", "label": "Finance", "providers": ["sample", "upload", "google_places", "sebi_ria", "osm", "open_web", "finra"] }
]
```

### `GET /api/templates`

Returns all pre-built `JobSpec` templates (see shape below).

### `POST /api/agent-search` — autonomous, blocking

The primary search endpoint. No `provider` field — source selection is entirely autonomous.

Request:

```json
{
  "jobSpec": {
    "field": "finance",
    "title": "Analyst",
    "location": "Delhi",
    "criteria": [
      { "key": "skills", "label": "Core Skills", "weight": 5, "requiredSkills": ["equity research"] }
    ]
  },
  "topN": 10,
  "options": { "data": null, "useLLM": false }
}
```

- `topN` — ceiling on how many ranked candidates come back (1–50 as clamped by the frontend;
  the route itself doesn't enforce a max). It is a **ceiling, not a promise** — if fewer real
  people were found, the report says so rather than padding.
- `options.data` — raw CSV/JSON text from the recruiter's upload; always merges into the
  agent's pool alongside whatever else it found (no separate "upload only" mode).
- `options.useLLM` — enables both LLM-backed scoring and the LLM source-refinement pass in
  planning. Falls back to deterministic rules/planning on any failure.

Response: `{ candidates: Scored[], totalFound, matched, scoredBy, sourcePlan, agentLog, sourcesQueried }` — see [Response fields](#response-fields) above for what's on each candidate.

### `POST /api/agent-search/jobs` + `GET /api/agent-search/jobs/:jobId` — autonomous, async

The pollable counterpart, for the web UI and for anything that might run long (an
`open_web`-inclusive search, or a slow public API like Overpass).

`POST /api/agent-search/jobs` — same request body as above. Returns `202 { "jobId": "<uuid>" }`
immediately; the search runs in the background against an in-memory job map (no new deps, no
persistence across a server restart).

`GET /api/agent-search/jobs/:jobId` — poll this. Shape:

```json
{
  "jobId": "…",
  "status": "running",
  "startedAt": "…", "updatedAt": "…",
  "progress": { "phase": "sourcing", "sourcesTotal": 4, "sourcesDone": 2 },
  "result": null,
  "error": null
}
```

`status` is `"running"` or `"done"`. `progress.sourcesDone` increments in real time as each
planned source finishes (confirmed by repeated polling during verification — it genuinely
climbs mid-run, not just at completion). Once `status` is `"done"`, `result` holds the exact
same shape `POST /api/agent-search` returns synchronously. A job id that doesn't exist (unknown,
expired, or malformed) returns a 404 `R005`.

### `POST /api/search` — single named provider (legacy, still supported)

The original, non-autonomous endpoint: the caller picks exactly one provider by key. Left
byte-for-byte untouched by the agent-search work and still fully supported for direct,
single-source queries.

Request:

```json
{
  "jobSpec": {
    "field": "software",
    "title": "Frontend Engineer",
    "location": null,
    "criteria": [
      { "key": "skills", "label": "Core Skills", "weight": 5, "requiredSkills": ["react", "typescript"] },
      { "key": "experience", "label": "Years of Experience", "weight": 4, "minYears": 3 }
    ]
  },
  "provider": "github",
  "options": { "useLLM": false }
}
```

- `provider` — one of the keys returned by `/api/fields` (any of the 16).
- `options.data` — raw CSV/JSON text, only read by the `upload` provider.
- `options.useLLM` — `true` to route scoring through the active LLM (falls back to rules on any
  failure).

Response:

```json
{
  "totalFound": 12,
  "candidates": [
    {
      "id": "github:torvalds",
      "name": "…", "headline": "…", "field": "software",
      "location": null, "yearsExperience": 5, "education": null, "educationLevel": null,
      "skills": ["…"], "certifications": [], "summary": "…",
      "source": "github", "sourceUrl": "https://github.com/…", "avatarUrl": "…", "raw": {},
      "criteriaScores": {
        "skills": { "raw": 0.75, "weighted": 3.75, "max": 5, "note": "matched 3/4 required skills" }
      },
      "totalScore": 82.14,
      "rank1to10": 8
    }
  ],
  "scoredBy": "rules"
}
```

Per-candidate `scoredBy`/`reasoning` fields are only present when `options.useLLM` was
`true` in the request (each candidate is then tagged `"llm"` or `"rules"` depending on
whether that individual candidate actually got an LLM judgment or fell back). The top-level
`scoredBy` always reflects whether *any* candidate in the response was LLM-scored. This
endpoint's candidates do **not** carry `dataCompleteness`/`sourceTrust`/`rankingScore` — those
are agent-search-only consolidation fields.

### `POST /api/results` and `GET /api/results/:id`

Unchanged. Persists a `{ jobSpec, candidates, scoredBy }` result set and returns a shareable id.

Request: `{ "jobSpec": {...}, "candidates": [...], "scoredBy": "rules" }`
Response: `{ "id": "aB3xQz", "url": "/?r=aB3xQz" }`

`GET /api/results/:id` returns the saved `{ id, createdAt, jobSpec, candidates, scoredBy }`
payload, or a 404 coded error (`R004`) if the id is unknown.

### MCP server

`node mcp-server.js` — a hand-rolled JSON-RPC 2.0 stdio server (no new dependency, no
`@modelcontextprotocol/sdk`) exposing `search_candidates`, `list_fields`, and
`list_job_templates` as MCP tools over the exact same `lib/agent/orchestrate.js` pipeline the
HTTP routes use. Full protocol reference, tool schemas, and client configuration in
[docs/MCP.md](./docs/MCP.md).

## Data contracts

See [PLAN.md](./PLAN.md) §3 for the frozen `Candidate`, `JobSpec`, `Criterion`, and
`Scored candidate` shapes that every provider, scorer, and route honors, and
[PLAN_V2.md](./PLAN_V2.md) §3–4 for the agent layer's architecture and design decisions built
on top of them.

## Architecture

```
server.js                  Express wiring only — mounts routes, serves public/
mcp-server.js               Hand-rolled MCP stdio server — same agent core, conversational front door
routes/
  health.js                 GET  /api/health
  fields.js                 GET  /api/fields
  templates.js               GET  /api/templates
  search.js                  POST /api/search              — single named provider, legacy but supported
  agentSearch.js              POST /api/agent-search         — autonomous, blocking
  agentJobs.js                 POST /api/agent-search/jobs,
                                GET  /api/agent-search/jobs/:jobId — autonomous, async + polling
  results.js                   POST /api/results, GET /api/results/:id — shareable result store
lib/
  normalize.js                normalizeCandidate() — the one place raw provider data becomes
                               the unified Candidate shape
  jobTemplates.js              JOB_TEMPLATES — pre-built JobSpecs per field
  resultsStore.js              saveResult()/getResult() — JSON files under data/results/
  agent/
    plan.js                    selectSources() — deterministic baseline + optional LLM add/skip
    orchestrate.js               agentSearch() — Promise.allSettled fan-out, timeouts, deadline
    dedupe.js                    three-tier merge (auto / corroborated / flag-only)
    trust.js                      SOURCE_TRUST tiers shared by dedupe + consolidate
    consolidate.js                 dataCompleteness / adjustedScore / rankingScore / agentRank1to10
    jobs.js                        in-memory job map for the async/polling endpoint
  scoring/
    rules.js                    scoreCandidate()/rankCandidates() — deterministic weighted scoring
    llm.js                       rankCandidatesLLM() — Anthropic/Groq/Gemini-backed scoring
                                  (auto-detected via activeLLMProvider()), same weight math,
                                  falls back to rules.js on any failure
  providers/                   16 providers — index.js is the registry (getProvider, listProviders)
data/
  samples/*.json               bundled synthetic candidate pools (sample provider only; excluded
                                from agent-search)
  registries/sebi_ria.json      bundled SEBI RIA snapshot (scripts/fetch-sebi-ria.mjs refreshes it)
  results/*.json                saved shareable result sets (created at runtime)
public/
  index.html                    the entire frontend — field picker → criteria form → N control →
                                 upload (collapsed) → autonomous agent-search → ranked results with
                                 trust badges, completeness bars, and a methodology panel
docs/
  ERROR_CODES.md                what every Rxxx code means
  MCP.md                        MCP server protocol reference
```

### Adding a new field template

Add an entry to the `JOB_TEMPLATES` array in `lib/jobTemplates.js` following the existing
shape (`{ field, title, location, criteria: [Criterion] }`). It immediately appears in
`GET /api/templates` and, if its `field` value is new, in `GET /api/fields` too. If you want
the `sample` provider to serve candidates for that field, also add
`data/samples/<field>.json` (an array of partial candidate objects) — see the `FIELD_TO_FILE`
alias map in `lib/providers/sample.js` if the field key and filename should differ (e.g.
`healthcare` → `nursing.json`). Note that `sample` is excluded from agent-search regardless.

### Adding a new data provider

Create `lib/providers/<name>.js` exporting `provider = { key, label, fields, async search(jobSpec, options) }`
that returns an array normalized through `normalizeCandidate()` (see `lib/normalize.js`).
Register it in the `PROVIDERS` map in `lib/providers/index.js`. `fields` is either a specific
list of field keys the provider serves, or `["*"]` for "any field". To make the autonomous
agent actually query it, also add it to the baseline in `lib/agent/plan.js` and give it a trust
tier in `lib/agent/trust.js` (unknown providers default to `"lead"`).

## Data-source honesty

Full detail is in [FAIRNESS.md](./FAIRNESS.md) — read it before acting on scores. Summary:

- **`github`** — real, live candidate data. `yearsExperience` is a proxy (years since account
  creation, not real work experience) and `skills` is inferred from most-used languages across
  public repos. FAIRNESS.md §3.
- **`sebi_ria`** — real, official government data, but a periodic snapshot, not a live feed.
  FAIRNESS.md §7.
- **`nmc`** — real, live government data, but no city-level filter (state-council only) and no
  specialization data. FAIRNESS.md §8.
- **`open_web`** — the only provider whose data isn't from a structured, authoritative source.
  Unverified leads, protected by a structural grounding gate but not proof of accuracy beyond
  the name string. Two real fabrication incidents (one invented name, one real person
  misattributed) are documented in full. FAIRNESS.md §9.
- **Consolidation ranking, dedupe, and platform exclusions** — `CONSOLIDATION_WEIGHTS` are
  invented heuristics needing real-world tuning; `lead`-tier rows always need click-through;
  dedupe deliberately under-merges, so the same person can appear twice; LinkedIn and Unstop
  are excluded by policy, permanently, and no future phase will add them. FAIRNESS.md §10.
- **`sample`** — entirely synthetic, fabricated demo candidates. Not real people, not a real
  labor market signal, and never mixed into agent-search results.
- **`upload`** — whatever the recruiter pastes in (CSV or JSON). As real as the data supplied.

## Further reading

- [PLAN.md](./PLAN.md) — original roadmap, frozen data contracts, single-provider phase history.
- [PLAN_V2.md](./PLAN_V2.md) — the autonomous-agent plan: architecture, the four hard problems
  (source selection, cross-source comparability, dedupe, latency/cost), and phase-by-phase
  verification history (all 6 phases done).
- [FAIRNESS.md](./FAIRNESS.md) — bias/fairness notes; read before acting on scores.
- [docs/ERROR_CODES.md](./docs/ERROR_CODES.md) — what each API error code means.
- [docs/MCP.md](./docs/MCP.md) — MCP server protocol reference and client setup.

## PLAN_V2 changelog

All six phases are done and verified — see PLAN_V2.md for the full verification record of each.

1. **Orchestration core** — `lib/agent/{plan,orchestrate,dedupe,consolidate}.js`,
   `POST /api/agent-search`. Deterministic source selection with optional LLM refinement,
   bounded fan-out, three-tier dedupe, dual-axis (completeness × trust) consolidated ranking.
2. **Autonomous frontend** — removed the source-picker UI entirely; added the `N` control,
   trust badges, completeness bars, methodology panel, and "group by confidence" toggle.
3. **Open-web reach & quality** — threaded the shrunk turn/time budget into `open_web` for
   real, fixed a Groq role bug that silently broke that backend, and added the structural
   anti-fabrication grounding gate after two live fabrication incidents.
4. **Trust, docs, honesty** — this pass: FAIRNESS.md §9/§10, this README, error-code docs,
   `.env.example`, and PLAN_V2.md status all brought in line with actual behavior.
5. **Progress & resilience** — `POST /api/agent-search/jobs` + `GET .../jobs/:jobId` polling,
   `lib/agent/jobs.js` in-memory job map, live `progress.sourcesDone` reporting.
6. **MCP front door** — `mcp-server.js`, a hand-rolled stdio JSON-RPC server exposing
   `search_candidates`/`list_fields`/`list_job_templates` over the same agent core.

## Legacy changelog (pre-PLAN_V2, single-provider era)

- **Stack Overflow provider** (`stackoverflow`) — real candidates pulled from the free Stack
  Exchange API, top answerers on the tag derived from the job spec's skills criterion.
- **Required criteria** — any criterion can be marked `required: true`; candidates that don't
  fully meet every required criterion (raw < 1) are dropped from the results, and `matched`
  in the response reflects the post-filter count.
- **Free-tier LLM reasoning** — `lib/scoring/llm.js` auto-detects and routes through
  Groq (`llama-3.3-70b-versatile`) or Gemini (`gemini-2.0-flash`) in addition to Anthropic,
  so AI reasoning works with a free key and no Anthropic account.
- **Saved searches** — the frontend persists named job-spec + options combos to
  `localStorage` (`recruiter-saved-searches`) for quick re-run.
