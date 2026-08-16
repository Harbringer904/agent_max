# Fairness & Bias Notes

Honest notes on what this tool is, what it isn't, and where its numbers can mislead a
recruiter who doesn't know how they were built. Read this before using scores to make or
influence a hiring decision.

## 1. This is decision-support, not an autonomous filter

agent_max ranks candidates against **recruiter-defined, weighted criteria** and produces a
`totalScore` (0–100) and `rank1to10`. It does not accept, reject, or auto-advance anyone. No
score from this tool should ever be the sole reason a candidate is dropped from a process —
it is an input to a human decision, not a replacement for one.

## 2. We do not add protected-attribute criteria

The `Criterion` schema (`skills`, `experience`, `education`, `certifications`, `location`,
`keyword`) intentionally has no field for race, gender, age, disability, national origin,
religion, or other protected characteristics, and none should ever be added. `location` is
a proxy that can correlate with protected classes (e.g. national origin, immigration status)
depending on how a recruiter uses it — use it to express legitimate work-authorization or
timezone needs, not as a stand-in for anything else.

## 3. GitHub signals are proxies, not direct measurements

The GitHub provider (`lib/providers/github.js`) infers two fields that are **not** what they
appear to be:

- `yearsExperience` is actually **years since the GitHub account was created**
  (`yearsSinceAccountCreated`). Someone who has coded professionally for a decade but only
  created a GitHub account last year will score as a 1-year candidate. Someone who made an
  account in college and never worked professionally will score as more experienced than
  they are.
- `skills` is the candidate's **most-used languages across their own public, non-fork repos**
  (`getUserTopLanguages`). This favors people with public open-source activity and
  under-counts (or completely misses) skills exercised only in private repos, at work behind
  a corporate GitHub Enterprise instance, or in ecosystems the candidate doesn't push code
  for publicly (e.g. a backend engineer who also does undocumented but substantial infra
  work).

Net effect: the GitHub provider systematically favors candidates who are active in public
open source and have held a GitHub account for a long time, and under-credits candidates
whose real experience lives in private/enterprise codebases. Treat GitHub-sourced scores as
a rough signal to investigate further, not a measurement of actual skill or tenure.

## 4. LLM scores are not deterministic

When AI reasoning is enabled (`lib/scoring/llm.js`), the same candidate can receive a
different `raw` score or `reasoning` text on a re-run against the identical `jobSpec`, since
the underlying model call is not guaranteed to return byte-identical output every time. The
weight math on top (`applyWeights`) is deterministic — only the LLM's per-criterion judgment
varies. Don't treat a single LLM run as a precise, reproducible measurement; if a
close-call ranking matters, re-run it or have a human read the `reasoning` field directly.

## 5. Always have a human review results before acting on them

Every ranked list is a starting point for a recruiter to review, not a final verdict.
Before contacting, advancing, or rejecting any candidate:

- Read the `criteriaScores[key].note` / `reasoning` fields — they explain *why* a score
  landed where it did, and often reveal a proxy artifact (see §3) rather than a real gap.
- Cross-check low scores caused by **missing data** (e.g. `"no experience data"`,
  `"no skills data"`) against the candidate's actual background — a `0` raw score from
  absent data is not the same as a `0` raw score from a documented mismatch.
- Apply your organization's own equal-opportunity review process; this tool does not
  replace it.

## 6. Sample datasets are synthetic

The bundled datasets under `data/samples/*.json` (software, design, finance, sales, nursing)
are **fabricated demo data** for exercising the UI and scoring engine end-to-end. They do not
represent real people, and any resemblance of a sample candidate's name or profile to a real
person is coincidental. Do not use sample-dataset results to make claims about real labor
markets or real candidates. The `upload` provider (recruiter-supplied CSV/JSON), the `github`
provider (live GitHub API), and the `stackoverflow` / `google_places` / `sebi_ria` providers
(below) reflect real candidate data — and per §3, `github`'s fields are proxies, not ground
truth.

## 7. `sebi_ria` is a periodic snapshot, not a live feed

`data/registries/sebi_ria.json` is a downloaded copy of SEBI's own public, no-login Registered
Investment Adviser directory (sebi.gov.in), fetched by `scripts/fetch-sebi-ria.mjs`. It is real,
official government data — but it is a **point-in-time snapshot**, not a live query on every
search. A recently-registered or recently-deregistered adviser may not be reflected until the
snapshot is refreshed. Always verify an individual adviser's current status directly at
sebi.gov.in before relying on it for a real decision. `yearsExperience` here is "years since
SEBI registration," a tenure proxy — not total career experience.

We evaluated ICAI's Chartered Accountant directory for the same treatment and did not add it:
ICAI's member data is fragmented across regional-branch PDFs with no consolidated bulk source
we could verify as reliable, unlike SEBI's single, stable, paginated public listing. Rather
than ship a fragile scraper against an unverified target, we left it out — see the project's
build notes for more.

## 8. `nmc` is a live query against a registry with limited fields

Unlike `sebi_ria`, the NMC (National Medical Commission) provider queries India's official
doctor registry live, on every search — it's too large (1M+ doctors nationally) to bundle.
Real limitations to know about:
- **No city-level filter exists in the source data.** NMC only exposes State Medical Council,
  so "Delhi" actually means "registered with the Delhi Medical Council" — which includes
  doctors who registered there but may now practice elsewhere, and excludes doctors practicing
  in Delhi who registered with a different state's council.
- **`yearsExperience` is "years since medical degree,"** not verified current practice years or
  specialization-specific experience.
- **No specialization/skills data** is available from NMC's public API — `skills` here is just
  the medical degree (e.g. "MBBS"), not a specific medical specialty.
- Detail enrichment (degree, university, address) is best-effort per doctor; when it fails for
  a given candidate, that candidate still appears with less detail rather than being dropped.

## 9. `open_web` results are unverified — treat them as leads, not confirmed candidates

Unlike every other provider, `open_web`'s data isn't from a structured, authoritative source —
it's whatever an LLM found via web search and decided looked relevant. Concretely:
- The LLM extracts name/skills/location from free text on a page. It can misread, misattribute,
  or hallucinate details despite being instructed not to invent people.
- A page turning up in search doesn't mean the person is actually job-seeking, actually skilled
  as described, or that the page is current.
- **Always click through to `sourceUrl` and verify a candidate yourself** before treating an
  `open_web` result as real — more so than for any other source in this app.
- It only sees what a legitimate search index (Tavily) surfaces from the public, crawlable web
  — it does not and cannot access LinkedIn or other login-gated/ToS-restricted platforms.

**Live-verified findings (PLAN_V2 Phase 3, real Tavily + Groq keys):**
- In one live run, the agent extracted a company/agency homepage (`planahead.in`) that named no
  individual anywhere on the page, and — under pressure to fill the required `candidates[].name`
  field on its last available turn — invented a plausible-sounding name ("Tej Shah") and attached
  it to the firm's own self-description. The `sourceUrl` was real; the *person* was not. This is
  exactly the fabrication risk described above, caught by manually fetching the cited URL and
  confirming no such name appears on it. The system prompt was strengthened to explicitly call
  out this "required schema field vs. nameless page" trap and instruct the agent to skip such a
  page rather than invent a name — re-tested afterward and the same page no longer produced a
  fabricated candidate — but this is a probabilistic mitigation, not a guarantee. **Manual
  click-through on every `open_web` lead remains mandatory**, especially anything sourced from a
  company/agency page rather than a personal profile.
- The shrunk per-run budget (`maxTurns: 3` inside the orchestrated agent-search, vs. up to 10
  standalone) is a genuine tradeoff, not just a latency guard: a search that needs
  search → extract → submit (3 turns) can succeed, but one that needs an extra search or a second
  extract before it has enough to submit will hit the turn ceiling and return zero candidates for
  a query that a longer run would have answered. Several otherwise-identical live runs returned 0
  candidates under the orchestrated budget where a standalone run with one more turn found real
  people. Treat an empty `open_web` result inside agent-search as "budget-limited," not "nothing
  exists on the open web for this query."
- On the Groq backend (`llama-3.3-70b-versatile`), the model occasionally emits a malformed
  pseudo-function-call instead of a structured tool call, which Groq's API rejects with a 400.
  This is handled per the existing fault-tolerance contract (caught, logged, `[]` returned,
  never thrown to the caller) and does not crash a search — but it does mean an occasional
  `open_web` run silently contributes nothing even when the LLM key and Tavily key are both fine.
