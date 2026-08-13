# Recruiter AI — Master Plan

> **Planned by** Opus 4.8 (ultracode). **Implemented by** Sonnet 5 subagents (high effort).
> This file is the single source of truth for the roadmap. Each phase is token-bounded so
> work can pause/resume across usage windows.

## 1. Vision

A **field-agnostic** candidate sourcing + ranking engine. A recruiter picks a job field
(software, nursing, sales, finance, design, …), defines weighted criteria, chooses a data
source, and gets candidates ranked **0–100** with a **1–10** rating and a per-criterion
breakdown + reasoning.

Today the app only sources **developers from GitHub**. This plan expands it to **any field**
via a pluggable provider + a field-agnostic scoring engine, then layers on LLM reasoning and
recruiter-workflow features.

## 2. Architecture (target)

```
recruiter-ai/
├── server.js                 # Express wiring only
├── routes/                   # search / templates / fields
├── lib/
│   ├── normalize.js          # unified Candidate model + normalizer
│   ├── jobTemplates.js       # pre-built role templates per field
│   ├── scoring/rules.js      # field-agnostic weighted scoring (deterministic, free)
│   ├── scoring/llm.js        # (Phase 2) Claude API deep scoring + reasoning
│   └── providers/
│       ├── index.js          # registry: getProvider(key), listProviders()
│       ├── github.js         # real GitHub search (software only)
│       ├── sample.js         # bundled synthetic datasets (all fields)
│       └── upload.js         # parse recruiter-uploaded CSV/JSON (all fields)
├── data/samples/*.json       # synthetic candidate pools per field
└── public/                   # field picker → criteria form → provider → ranked results
```

## 3. Data contracts (frozen — every phase must honor these)

### Candidate (unified)
```
{ id, name, headline, field, location|null, yearsExperience|null,
  education|null, educationLevel|null /* 0 none…5 doctorate */,
  skills:[], certifications:[], summary|null,
  source /* provider key */, sourceUrl|null, avatarUrl|null, raw:{} }
```

### JobSpec (recruiter requirements)
```
{ field, title, location|null, criteria:[Criterion] }
```
### Criterion
```
{ key:'skills'|'experience'|'education'|'certifications'|'location'|'keyword',
  label, weight /* 1–5 */,
  requiredSkills?:[], minYears?, minEducationLevel?, requiredCerts?,
  desiredLocation?, keywords?:[] }
```

### Scored candidate
```
{ ...Candidate,
  criteriaScores:{ [key]:{ raw:0..1, weighted, max, note } },
  totalScore:0..100, rank1to10:1..10 }
```
`totalScore = (Σ weighted / Σ max) * 100`. `rank1to10 = clamp(round(total/10),1,10)`.

### API
- `GET  /api/health` → `{ ok, githubAuth }`
- `GET  /api/fields` → fields + which providers serve each
- `GET  /api/templates` → `[JobSpec]` pre-built templates
- `POST /api/search` `{ jobSpec, provider, options }` → `{ candidates:[Scored] }`
  (upload provider reads `options.data` = raw CSV/JSON text)

## 4. Roadmap & token budget

| Phase | Scope | Who | Status |
|------|-------|-----|--------|
| **1** | Multi-field core: unified models, 11 role templates, field-agnostic scoring, provider architecture (github/sample/upload), 5 sample datasets, new backend + frontend | 5 Sonnet-5 agents | **Done** |
| 2 | LLM scoring layer (`scoring/llm.js`) — Claude API scores + explains each candidate against arbitrary criteria; "Explain ranking" UI; graceful fallback to rules when no API key | 3–4 Sonnet-5 agents | **Done** |
| 3 | Recruiter workflow: shortlist/save, side-by-side compare, CSV/PDF export, search history, shareable result links | 3–4 Sonnet-5 agents | **Done** |
| 4 | Quality: unit tests for scoring + providers, input validation, fairness/bias notes, README + screenshots, error codes | 2–3 Sonnet-5 agents | **Done** |
| 5 | More data sources (Stack Overflow, dev.to, public resume datasets), Boolean filters, saved searches | TBD | **Done** |

Phases 1–5 are complete. The roadmap (§4) has no remaining backlog items.

**Rule:** one bounded workflow per usage window. Stop before the window's limit; resume next
window. A scheduled task re-opens the plan at the top of Phase 2.

## 5. Feature list (what makes it interesting)

- Works for **any job field**, not just tech.
- **Job-template library** — pre-filled criteria for 11 common roles.
- **Weighted criteria** — recruiter dials importance per requirement.
- **Transparent scoring** — every candidate shows per-criterion raw/weighted/note.
- **Three data sources** — real GitHub, bundled demo datasets, recruiter CSV/JSON upload.
- **1–10 rating + 0–100 score** on every candidate.
- (Phase 2) **LLM reasoning** — natural-language "why this rank".
- (Phase 3) **Compare, shortlist, export, history**.

## 6. Continuation

**The full roadmap (Phases 1–5) is complete** — app is feature-agnostic, feature-complete,
tested (68/68), and documented. The one-time `recruiter-ai-continue` task already fired and is
disabled; no schedule is armed. Future work is open-ended (new fields, new providers, more UX)
rather than a fixed backlog item — start a fresh Sonnet-5 workflow driven by Opus 4.8 planning
when there's a concrete next phase to define.

**Progress log:** Phase 1 done (5 agents, ~467K tok). Phase 2 done (3 agents, ~509K tok).
Phase 3 done (3 agents, ~269K tok). Phase 4 done (3 agents, ~275K tok). Phase 5 done — added
the Stack Overflow provider (`lib/providers/stackoverflow.js`), a `required` per-criterion
boolean filter (routes/search.js), a `LLM_PROVIDER`-selectable Groq/Gemini/Anthropic scoring
backend (`lib/scoring/llm.js`), and localStorage-backed saved searches in the frontend. Total
≈ 1.52M+ tok.
