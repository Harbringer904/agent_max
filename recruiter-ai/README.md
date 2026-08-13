# Recruiter AI

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
- **Five data sources** — real GitHub profiles, real Stack Overflow top-answerers, real local
  businesses/professionals via Google Places (any field, any city), bundled synthetic sample
  datasets (any field), and recruiter-supplied CSV/JSON upload.
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
{ "ok": true, "githubAuth": false, "googlePlacesAvailable": false, "llmAvailable": false, "llmProvider": null }
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

### `POST /api/search`

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

## Further reading

- [PLAN.md](./PLAN.md) — roadmap, frozen data contracts, phase history.
- [FAIRNESS.md](./FAIRNESS.md) — bias/fairness notes; read before acting on scores.
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
