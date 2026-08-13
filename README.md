# Recruiter AI

**A field-agnostic candidate sourcing & ranking engine.** Define what you want in a hire —
weighted by importance — pick a data source, and get candidates ranked **0–100** (plus a **1–10**
rating) with a transparent, per-criterion breakdown. Works for any job field, not just tech.

> Built as an agentic project: planned by Claude Opus 4.8 and implemented by Claude Sonnet 5
> sub-agents across five phases. See [`recruiter-ai/PLAN.md`](recruiter-ai/PLAN.md) for the roadmap.

---

## ✨ Features

- **Any field** — 11 built-in job templates across software, healthcare, finance, sales,
  marketing, design, and operations.
- **Weighted criteria** — dial the importance (1–5) of skills, experience, education,
  certifications, location, and keywords. Mark any criterion **required** for a hard filter.
- **Transparent scoring** — every candidate shows the raw/weighted score and a note per criterion.
- **Four data sources**
  - **GitHub** — live developer search (real API).
  - **Stack Overflow** — live top-answerer search by skill tag (real API, no key).
  - **Sample datasets** — bundled synthetic candidates for every field (great for demos).
  - **Upload** — paste a CSV or JSON of your own candidates.
- **Optional AI reasoning** — a natural-language "why this rank" per candidate, powered by an LLM,
  with a **provider-agnostic** backend (Groq, Google Gemini, or Anthropic) and a graceful
  fallback to the deterministic scorer when no key is set.
- **Recruiter workflow** — shortlist ⭐, side-by-side compare ⚖️, CSV + print/PDF export,
  search history, **saved searches**, and shareable read-only result links.
- **Tested & documented** — 68 unit tests, opaque API error codes, and a fairness statement.

---

## 🚀 Quick start

```bash
cd recruiter-ai
npm install
node server.js
# open http://localhost:3000
```

That's it — the app runs fully on the deterministic scorer with **no keys required**.

### Optional keys (`.env`)

Copy `recruiter-ai/.env.example` to `recruiter-ai/.env` and fill in what you have:

| Variable | Purpose | Cost |
| --- | --- | --- |
| `GITHUB_TOKEN` | Higher GitHub rate limits (5000/hr vs 60/hr) | Free |
| `GROQ_API_KEY` | AI reasoning via Llama 3.3 | **Free** — [console.groq.com](https://console.groq.com) |
| `GEMINI_API_KEY` | AI reasoning via Gemini 2.0 Flash | **Free** — [aistudio.google.com](https://aistudio.google.com) |
| `ANTHROPIC_API_KEY` | AI reasoning via Claude | Paid |

Only **one** LLM key is needed. Priority: `ANTHROPIC_API_KEY` > `GROQ_API_KEY` > `GEMINI_API_KEY`
(override with `LLM_PROVIDER`). **Never commit `.env`** — it's git-ignored for a reason.

---

## 🧠 How scoring works

Each criterion produces a raw match `0..1`, multiplied by its weight. The total is normalized to
`0–100`; `rank1to10 = round(total / 10)`. When AI reasoning is enabled, the LLM judges each
criterion's raw fit and writes the explanation, but the **same weight math** is applied locally so
LLM and rule-based scores stay directly comparable.

---

## 🗂 Project structure

```
recruiter-ai/
├── server.js            # Express wiring
├── routes/              # health · fields · templates · search · results
├── lib/
│   ├── normalize.js     # unified Candidate model
│   ├── jobTemplates.js  # 11 role templates
│   ├── scoring/
│   │   ├── rules.js     # deterministic weighted scorer (free)
│   │   └── llm.js       # Groq / Gemini / Anthropic reasoning + fallback
│   └── providers/       # github · stackoverflow · sample · upload
├── data/samples/        # synthetic candidate pools per field
├── public/index.html    # single-page UI (warm "woody" theme)
└── test/                # 68 node:test unit tests
```

## 🔌 API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | status + which LLM provider is active |
| `GET` | `/api/fields` | fields and which providers serve each |
| `GET` | `/api/templates` | the 11 job templates |
| `POST` | `/api/search` | `{ jobSpec, provider, options }` → ranked candidates |
| `POST` | `/api/results` | save a result set → `{ id, url }` (shareable link) |
| `GET` | `/api/results/:id` | reopen a saved result set |

Full request/response shapes are documented in
[`recruiter-ai/README.md`](recruiter-ai/README.md).

## ✅ Tests

```bash
cd recruiter-ai && npm test
```

---

## 📚 More docs

- [`recruiter-ai/README.md`](recruiter-ai/README.md) — full app docs & API reference
- [`recruiter-ai/PLAN.md`](recruiter-ai/PLAN.md) — the five-phase build roadmap
- [`recruiter-ai/FAIRNESS.md`](recruiter-ai/FAIRNESS.md) — responsible-use / bias notes
- [`recruiter-ai/docs/ERROR_CODES.md`](recruiter-ai/docs/ERROR_CODES.md) — API error codes

## ⚖️ Responsible use

This is a **decision-support** tool, not an autonomous filter. Scores are heuristic — always
review candidates yourself. See [`FAIRNESS.md`](recruiter-ai/FAIRNESS.md).

## License

MIT
