# agent_max

A **field-agnostic** candidate sourcing and ranking tool. Pick a job field (software,
healthcare, sales, finance, design, …), define weighted requirements, choose a data source,
and get candidates ranked 0–100 with a 1–10 rating, a transparent per-criterion breakdown,
and (optionally) natural-language AI reasoning.

> This is decision-support, not an autonomous filter. Read [FAIRNESS.md](./FAIRNESS.md)
> before using scores to inform a real hiring decision.

## Quick start

Requires Node.js >= 18 (uses the built-in `fetch` and `node:test`).

```bash
npm install
node server.js
```

Open http://localhost:3000.

### Optional environment variables

Copy `.env.example` to `.env` and fill in what you need — everything is optional, the app
runs with zero configuration using the `sample` and `upload` providers.

| Variable            | Purpose                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`       | Raises the GitHub provider's rate limit from 60 req/hr to 5000 req/hr. Create one at https://github.com/settings/tokens (no scopes needed — only public data is read). Without it, the `github` provider still works, just slower. |
| `GOOGLE_PLACES_API_KEY` | Enables the `google_places` provider — real local businesses/professionals for **any field, any city** (e.g. "financial consultants in Delhi"), via Google's Places API (New) Text Search. Requires a Google Cloud project with billing enabled; the free monthly credit covers normal use. Without it, the provider silently returns no results. |
| `ANTHROPIC_API_KEY`  | Enables the "🧠 AI reasoning" toggle, routing scoring through Claude (`claude-sonnet-5`) for a natural-language per-candidate justification (`lib/scoring/llm.js`). |
| `GROQ_API_KEY`       | Same AI reasoning toggle, routed through Groq's free tier (`llama-3.3-70b-versatile`) instead of Claude. Get a free key at https://console.groq.com. |
| `GEMINI_API_KEY`     | Same AI reasoning toggle, routed through Google's free tier (`gemini-2.0-flash`) instead of Claude. Get a free key at https://aistudio.google.com. |
| `LLM_PROVIDER`       | Optional override when multiple LLM keys are set: `anthropic`, `groq`, or `gemini`. Default priority without it: Anthropic > Groq > Gemini. |
| `PORT`               | Server port. Defaults to `3000`.                                                                  |

Only **one** of `ANTHROPIC_API_KEY` / `GROQ_API_KEY` / `GEMINI_API_KEY` is needed to enable AI
reasoning — Groq and Gemini both offer free keys. Without any of them, every search silently and
automatically falls back to the deterministic rules-based scorer (`lib/scoring/rules.js`) —
nothing breaks, you just don't get the `reasoning` text.

## Features

- **Any job field** — not just tech. Ships with software, healthcare, sales, finance, and
  design templates; add more by editing `lib/jobTemplates.js` and (optionally) a sample
  dataset.
- **Job-template library** — pre-filled weighted criteria for common roles per field, used to
  seed the criteria form (`GET /api/templates`).
- **Weighted, transparent scoring** — every candidate shows a per-criterion `raw` fit (0–1),
  `weighted` contribution, `max` possible, and a human-readable `note` explaining the
  judgment, plus an overall `totalScore` (0–100) and `rank1to10` (1–10).
- **Nine data sources** — real GitHub profiles, real Stack Overflow top-answerers, real local
  businesses via Google Places (any field/city, needs a paid-tier key) or **OpenStreetMap**
  (any field/city, completely free, no key — but coverage and uptime are best-effort, see
  below), the **official SEBI Registered Investment Adviser registry** (real, 1000+
  India-wide financial consultants — the default source for the finance field), the **official
  NMC Registered Doctor registry** (real, 31,000+ doctors under Delhi's council alone — the
  default source for the healthcare field, live-queried and filterable by major Indian
  city/state), **`open_web`** — a genuinely agentic source: an LLM in a multi-turn tool-calling
  loop that searches the open web and reads pages *on its own* to find candidates for any
  field/city (see below), bundled synthetic sample datasets (any field), and recruiter-supplied
  CSV/JSON upload — which can optionally be **combined** with that field's default data source
  instead of searching your upload alone.

  **On `open_web`:** every other provider runs one fixed, hardcoded query. This one is different
  — the LLM decides for itself how many searches to run, which pages to read, and when it has
  enough (capped at 6 loop turns / 10 candidates). It needs **two separate free keys**: an LLM
  (`GROQ_API_KEY`/`GEMINI_API_KEY`/`ANTHROPIC_API_KEY`, same as the reasoning toggle) to drive
  the loop, plus `TAVILY_API_KEY` (free, no card, from [tavily.com](https://tavily.com) — a
  search+extract API built specifically for AI agents) as its web-search tool. Generic public
  search engines (DuckDuckGo's HTML endpoint, public SearXNG instances) were tested first and
  rejected automated/sandboxed traffic with bot-detection challenges before Tavily was chosen.
  It never touches LinkedIn or any ToS-gated site — it only sees what Tavily's index surfaces.
  Without both keys it returns no results (never crashes search) — confirmed live.

  **On `nmc`:** unlike `sebi_ria` (a small bundled snapshot), this is a **live** query against
  India's National Medical Commission registry — it's too large to bundle. It filters by State
  Medical Council (India has no city-level doctor registry; a handful of major cities are
  mapped to their state's council in `lib/providers/nmc.js`'s `CITY_TO_SMC_ID`) and enriches
  each result with a per-doctor detail call (degree, university, address) on a best-effort
  basis. **TLS note:** nmc.org.in's certificate chain is missing an intermediate cert (a known
  misconfiguration on some Indian institutional sites — verified independently, the leaf cert
  is genuinely Sectigo-issued); this provider uses a dedicated `https.Agent` that skips chain
  verification for *only* its own requests. Every other provider in the app keeps full TLS
  verification.

  **On `osm` (OpenStreetMap):** it's genuinely free (no key, no card), but it depends on two
  things outside our control: OpenStreetMap's free public Overpass API instances (shared,
  rate-limited, no uptime SLA — can be slow or return `429` under load) and volunteer tagging
  density (thinner for professional-services offices than Google's index, especially outside
  major cities). It is deliberately **not** set as any field's default for this reason — treat
  it as a free bonus attempt, not a primary source. It fails gracefully (returns no results,
  never crashes search) whenever the public infrastructure is unavailable.
- **Optional AI reasoning** — when one of `ANTHROPIC_API_KEY` / `GROQ_API_KEY` /
  `GEMINI_API_KEY` is set and the toggle is on, the active provider scores each candidate
  against each criterion and supplies a 1–2 sentence `reasoning` field, with the same weight
  math applied locally so LLM and rules scores stay directly comparable. Falls back to rules
  scoring on any failure (missing key, network error, malformed response) — search never
  breaks because of the LLM path.
- **Recruiter workflow** — shortlist candidates, compare side by side, export results,
  search history, and shareable read-only result links (`POST /api/results` /
  `GET /api/results/:id`).

## API reference

All endpoints are under `/api`. Errors use an opaque, coded shape —
`{ "error": "<generic message> (Rxxx)" }` — see [docs/ERROR_CODES.md](./docs/ERROR_CODES.md)
for what each code actually means.

### `GET /api/health`

```json
{ "ok": true, "githubAuth": true, "googlePlacesAvailable": false, "openWebAvailable": true,
  "llmAvailable": true, "llmProvider": "groq" }
```

`llmProvider` is `"anthropic" | "groq" | "gemini" | null` — whichever backend is active per
the `ANTHROPIC_API_KEY` / `GROQ_API_KEY` / `GEMINI_API_KEY` / `LLM_PROVIDER` env vars.

### `GET /api/fields`

Fields derived from registered providers + job templates, and which providers serve each.

```json
[
  { "key": "software", "label": "Software", "providers": ["github", "sample", "upload"] },
  { "key": "healthcare", "label": "Healthcare", "providers": ["sample", "upload"] }
]
```

### `GET /api/templates`

Returns all pre-built `JobSpec` templates (see shape below).

### `POST /api/agent-search` — the autonomous endpoint (what the UI uses)

**This is the main entry point.** The caller does NOT choose a data source. The agent picks
which of the 16 providers to query, runs them in parallel, dedupes people found in more than
one place, and returns ONE consolidated ranked list.

```jsonc
// request
{ "jobSpec": { "field": "finance", "title": "Adviser", "location": "Delhi", "criteria": [ … ] },
  "topN": 10,                                   // ceiling, not a promise (1–50, default 10)
  "options": { "useLLM": false, "data": "…" } } // data = optional CSV/JSON upload, merged in
```

```jsonc
// response
{ "candidates": [ { /* Scored, plus: */
      "dataCompleteness": 1,        // 0–1 — how much of the jobSpec this source could answer
      "adjustedScore": 96,          // score over ONLY the answerable criteria
      "sourceTrust": "verified",    // "verified" | "profile" | "lead"
      "rankingScore": 96.5,         // the actual sort key
      "agentRank1to10": 10,
      "provenance": [ … ],          // present when merged across sources
      "possibleDuplicateOf": null,  // set when a likely dupe was NOT merged
      "totalScore": 96.47, "rank1to10": 10, "criteriaScores": { … } } ],
  "totalFound": 33, "matched": 33, "scoredBy": "rules",
  "sourcePlan": [ { "providerKey": "sebi_ria", "reason": "finance field: official SEBI registry" } ],
  "agentLog": "…",                  // NOTE: a newline-separated STRING, not an array
  "sourcesQueried": [ { "key": "sebi_ria", "count": 25, "ms": 28, "status": "ok" } ] }
```

Ranking uses **two orthogonal axes** — see [How scoring works](#-how-scoring-works).

### `POST /api/agent-search/jobs` + `GET /api/agent-search/jobs/:jobId` — with live progress

A multi-source search takes 20–60s. The blocking endpoint above gives no feedback and risks
proxy idle-timeouts, so the UI uses this job/polling pair instead:

```jsonc
POST /api/agent-search/jobs   { jobSpec, topN, options }   ->  202 { "jobId": "…" }

GET  /api/agent-search/jobs/:jobId ->
{ "status": "running" | "done" | "error",
  "progress": { "phase": "sourcing", "sourcesTotal": 4, "sourcesDone": 2 },
  "sourcePlan": [ … ],
  "sourcesQueried": [ … ],   // grows incrementally as each source settles
  "agentLog": "…",
  "result": { /* the full agent-search response, once status === "done" */ },
  "error": null }
```

Jobs are in-memory with a 10-minute TTL. The blocking endpoint remains available and unchanged.

### `POST /api/search` — legacy, explicit single provider

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
  "provider": "sample",
  "options": { "useLLM": false }
}
```

- `provider` — one of the keys returned by `/api/fields` (`github`, `sample`, `upload`).
- `options.data` — raw CSV/JSON text, only read by the `upload` provider.
- `options.useLLM` — `true` to route through Claude (falls back to rules on any failure).

Response:

```json
{
  "totalFound": 12,
  "candidates": [
    {
      "id": "sample:0",
      "name": "…", "headline": "…", "field": "software",
      "location": null, "yearsExperience": 5, "education": "…", "educationLevel": 3,
      "skills": ["…"], "certifications": [], "summary": "…",
      "source": "sample", "sourceUrl": null, "avatarUrl": null, "raw": {},
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
`scoredBy` always reflects whether *any* candidate in the response was LLM-scored.

### `POST /api/results`

Persists a `{ jobSpec, candidates, scoredBy }` result set and returns a shareable id.

Request: `{ "jobSpec": {...}, "candidates": [...], "scoredBy": "rules" }`
Response: `{ "id": "aB3xQz", "url": "/?r=aB3xQz" }`

### `GET /api/results/:id`

Response: the saved `{ id, createdAt, jobSpec, candidates, scoredBy }` payload, or a 404
coded error (`R004`) if the id is unknown.

## 🧠 How scoring works

Each criterion yields a raw match `0..1`, multiplied by its weight. `totalScore` normalizes
that to 0–100 and `rank1to10 = round(total/10)`. **These two fields are frozen and unchanged.**

But raw `totalScore` is *not* the sort key for agent-search, because it is misleading across
sources of different richness: a SEBI adviser with certs + tenure + location scores ~96, while
an equally good person found on the open web scores ~18 **purely because the data is thinner**.

Naive renormalization is also wrong — it *launders* thin data (a lead matching 1-of-1 answerable
criteria would renormalize to a perfect 100). So agent-search uses **two orthogonal axes**:

| Field | Meaning |
| --- | --- |
| `dataCompleteness` | 0–1, weight-weighted share of criteria the source could actually answer |
| `adjustedScore` | the same weighted math, restricted to those answerable criteria |
| `sourceTrust` | `verified` (official registries, your upload) · `profile` (real public profiles) · `lead` (thin/inferred) |
| **`rankingScore`** | `adjustedScore × (0.5 + 0.5·dataCompleteness) × trustFactor` — **the sort key** |

Trust and completeness are genuinely independent: an `open_web` hit can be *fully complete*
(the LLM filled every field off a portfolio page) and still entirely **unverified**.

Worked example — the thin candidate is rescued from an unfair 17.65 up to a fair 60, but
damping and trust still stop it from beating a documented, verified match:

| Candidate | `totalScore` | `adjustedScore` | completeness | `rankingScore` |
| --- | --- | --- | --- | --- |
| Thin lead (`open_web`) | 17.65 | **60** | 0.29 | **29.1** |
| Real adviser (`sebi_ria`) | 96.47 | 96 | 1.00 | **96.5** |

⚠️ The constants live in one exported object, `CONSOLIDATION_WEIGHTS` in
`lib/agent/consolidate.js`. They are **invented heuristics, not empirically derived** — tune
them against real result sets. See [FAIRNESS.md](./FAIRNESS.md).

## Data contracts

See [PLAN.md](./PLAN.md) §3 for the frozen `Candidate`, `JobSpec`, `Criterion`, and
`Scored candidate` shapes that every provider, scorer, and route honors.

## Architecture

```
server.js                 Express wiring only — mounts routes, serves public/
routes/
  health.js                GET  /api/health
  fields.js                GET  /api/fields
  templates.js              GET  /api/templates
  search.js                 POST /api/search    — validates request, calls a provider, scores
  results.js                 POST /api/results, GET /api/results/:id — shareable result store
lib/
  normalize.js               normalizeCandidate() — the one place raw provider data becomes
                              the unified Candidate shape
  jobTemplates.js             JOB_TEMPLATES — pre-built JobSpecs per field
  resultsStore.js             saveResult()/getResult() — JSON files under data/results/
  scoring/
    rules.js                  scoreCandidate()/rankCandidates() — deterministic weighted scoring
    llm.js                     rankCandidatesLLM() — Anthropic/Groq/Gemini-backed scoring
                                (auto-detected via activeLLMProvider()), same weight math,
                                falls back to rules.js on any failure
  providers/
    index.js                   registry — getProvider(key), listProviders()
    github.js                   real GitHub user search (field: software only)
    sample.js                   loads data/samples/<field>.json
    upload.js                   parses options.data as CSV or JSON
data/
  samples/*.json               bundled synthetic candidate pools per field
  results/*.json                saved shareable result sets (created at runtime)
public/
  index.html                    the entire frontend — field picker → criteria form →
                                 provider choice → ranked results, single-page, vanilla JS
```

### Adding a new field template

Add an entry to the `JOB_TEMPLATES` array in `lib/jobTemplates.js` following the existing
shape (`{ field, title, location, criteria: [Criterion] }`). It immediately appears in
`GET /api/templates` and, if its `field` value is new, in `GET /api/fields` too. If you want
the `sample` provider to serve candidates for that field, also add
`data/samples/<field>.json` (an array of partial candidate objects) — see the `FIELD_TO_FILE`
alias map in `lib/providers/sample.js` if the field key and filename should differ (e.g.
`healthcare` → `nursing.json`).

### Adding a new data provider

Create `lib/providers/<name>.js` exporting `provider = { key, label, fields, async search(jobSpec, options) }`
that returns an array normalized through `normalizeCandidate()` (see `lib/normalize.js`).
Register it in the `PROVIDERS` map in `lib/providers/index.js`. `fields` is either a specific
list of field keys the provider serves, or `["*"]` for "any field".

## Data-source honesty

- **`github`** — real, live candidate data from the GitHub API. `yearsExperience` is a proxy
  (years since account creation, not real work experience) and `skills` is inferred from the
  candidate's most-used languages across their own public repos. See
  [FAIRNESS.md](./FAIRNESS.md) §3 for what that does and doesn't tell you.
- **`sample`** — entirely synthetic, fabricated demo candidates bundled in `data/samples/`.
  Useful for exercising the UI and scoring end-to-end; not real people, not a real labor
  market signal.
- **`upload`** — whatever the recruiter pastes in (CSV or JSON). As real as the data supplied.

## 🔌 MCP front door — drive the agent from a chat window

The same agent core is exposed as MCP tools, so you can ask for a ranking in Claude Desktop /
Claude Code instead of opening the browser. It's a **hand-rolled, zero-dependency JSON-RPC
server** over stdio (no `@modelcontextprotocol/sdk` — that would break the two-dependency rule).

```json
{
  "mcpServers": {
    "agent_max": {
      "command": "node",
      "args": ["C:/Projects/agent_max/recruiter-ai/mcp-server.js"]
    }
  }
}
```

Tools: `search_candidates` (field, title, location, skills, minYears, topN), `list_fields`,
`list_job_templates`. It reads the same `.env`. Supports the `tools` capability only — no
resources/prompts/sampling. Details in [docs/MCP.md](./docs/MCP.md).

> **Tip:** pass a `title` (and ideally `skills`). With only a bare `field`, the agent scores
> against deliberately generic criteria, so everyone lands mid-range — that's honest, not broken.

## Further reading

- [PLAN.md](./PLAN.md) — the original 5-phase roadmap and frozen data contracts.
- [PLAN_V2.md](./PLAN_V2.md) — the autonomous-agent rebuild (Phases 1–6), including the
  architecture decisions and the tradeoffs that were explicitly rejected.
- [FAIRNESS.md](./FAIRNESS.md) — bias/fairness notes; **read before acting on scores**.
- [docs/MCP.md](./docs/MCP.md) — MCP server details.
- [docs/ERROR_CODES.md](./docs/ERROR_CODES.md) — what each API error code means.

## Phase 5 changelog

- **Stack Overflow provider** (`stackoverflow`) — real candidates pulled from the free Stack
  Exchange API, top answerers on the tag derived from the job spec's skills criterion.
- **Required criteria** — any criterion can be marked `required: true`; candidates that don't
  fully meet every required criterion (raw < 1) are dropped from the results, and `matched`
  in the response reflects the post-filter count.
- **Free-tier LLM reasoning** — `lib/scoring/llm.js` now auto-detects and routes through
  Groq (`llama-3.3-70b-versatile`) or Gemini (`gemini-2.0-flash`) in addition to Anthropic,
  so AI reasoning works with a free key and no Anthropic account.
- **Saved searches** — the frontend persists named job-spec + provider + options combos to
  `localStorage` (`recruiter-saved-searches`) for quick re-run.
