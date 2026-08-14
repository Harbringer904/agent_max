# agent_max — Plan V2: The Autonomous Consolidation Agent

> **Status:** Plan only. Nothing in here is implemented yet.
> **Supersedes:** the roadmap in [PLAN.md](./PLAN.md) (Phases 1–5, all shipped).
> **Designed by:** Opus 5 synthesis over 3 independent Sonnet-5 architecture proposals
> (pragmatic / max-autonomy / data-quality angles).

---

## 1. The goal, restated

The recruiter supplies **only**:

| Input | Notes |
| --- | --- |
| Field, title, location | as today |
| Weighted criteria | as today, incl. the `required` hard filter |
| **How many candidates to return (N)** | **new** control |
| An optional CSV/JSON upload | **optional** — the only source the user can still name |

The agent then decides **on its own** which of every legitimately reachable source to query,
queries them in parallel, merges and deduplicates the people it finds, scores them
**comparably despite wildly different data richness**, and returns **one consolidated ranked
report** of N candidates, each rated 1–10, with visible provenance and confidence.

**The data-source picker is removed from the UI entirely.**

---

## 2. Hard boundaries (verified this session — these do not move)

### ⛔ LinkedIn — excluded, permanently

- Public-profile search via LinkedIn's official API is restricted to **incorporated companies**,
  via a **3–6 month** review, priced case-by-case. Individual developers cannot get it.
- Scraping it violates their ToS, and they actively block automated traffic.
- **We will not build** LinkedIn scraping, credentialed access, or bot-detection evasion —
  not via a provider, not via MCP, not via a headless browser.

### ⛔ Unstop — excluded

- No public candidate API exists. Candidate data sits behind recruiter accounts.
- Only third-party *hackathon-listing* scrapers exist — not candidate profiles.

### ✅ What the agent *may* reach

- **Official public registries** — SEBI (finance), NMC (healthcare). Real, government-published,
  designed for public verification.
- **Public developer platforms with real APIs** — GitHub, Stack Overflow.
- **The open, crawlable web via a legitimate search index** (Tavily) — public portfolios,
  personal sites, public directories. If a public profile page happens to be in the search
  index, that is the index's doing; we do not target or scrape any ToS-gated platform.
- **Business/location indexes** — Google Places (paid-tier key), OpenStreetMap (free).
- **The recruiter's own uploaded file.**

> **Honest expectation-setting:** removing LinkedIn/Unstop costs less than it sounds. Everything
> else in the goal — autonomous source selection, no picker, optional upload, N control, one
> consolidated 1–10 ranking — is fully buildable, and the two government registries provide
> verified data that no job platform would give you anyway.

### 📌 On MCP

MCP is **not** a way to reach other companies' platforms — it lets an external AI client
(e.g. Claude Desktop) call **our** tools. LinkedIn and Unstop do not publish MCP servers, so
MCP cannot unlock them. It *is* genuinely useful as a second front door onto this agent
(ask for a ranking from a chat window instead of a browser) — scoped as **optional Phase 6**.

---

## 3. Architecture

```
POST /api/agent-search  { jobSpec, topN, options:{ data?, useLLM? } }
        │
        ▼
  lib/agent/plan.js ──── deterministic field→sources baseline
        │                 (+ optional LLM add/skip pass, membership-only, validated)
        ▼
  lib/agent/orchestrate.js ── Promise.allSettled fan-out
        │                      per-source timeout · global deadline · never throws
        ├── sebi_ria · nmc · github · stackoverflow · google_places · osm · open_web · upload
        ▼
  lib/agent/dedupe.js ──── URL-identity auto-merge · corroborated merge · flag-only
        ▼
  lib/scoring/rules.js  (UNCHANGED)  or  lib/scoring/llm.js  (UNCHANGED)
        ▼
  lib/agent/consolidate.js ── dataCompleteness · adjustedScore · trust · rankingScore
        ▼
  ONE ranked report  { candidates[], sourcePlan[], agentLog[], sourcesQueried[] }
```

**Everything under `lib/scoring/` and `lib/providers/` is reused unmodified.** The frozen
`Candidate` / `JobSpec` / `Scored` contracts and the 68 passing tests stay green. All new
behavior lives in a new `lib/agent/` layer plus a new route.

---

## 4. The four hard problems — decisions and rationale

### P1 · Source selection → **deterministic baseline, LLM refines**

- `selectSources(jobSpec)` computes a baseline from a static map (extends today's proven
  `defaultProviderForField`): finance always includes `sebi_ria`; healthcare `nmc`; software
  `github`+`stackoverflow`; location-anchored sources (`google_places`, `osm`) only when a
  location is given; `open_web` whenever `openWebAvailable()`.
- Each candidate source passes a cheap synchronous **availability check** first, so a source
  with no key is never dispatched.
- **When an LLM key exists**, one planning call may **add or skip** sources, with a stated
  reason surfaced in the report. It is **hard-constrained**: output validated against
  `listProviders()` (hallucinated keys dropped), capped at 5 sources, and **structurally
  forbidden from influencing scores or ordering** — mirroring the existing `applyWeights()`
  posture in `llm.js`, where LLM output is never trusted to define the contract.
- **With no LLM key the deterministic map is the whole mechanism** and still works — no
  regression for zero-config installs.

> *Rejected:* pure-LLM planning (Proposal 3). It makes zero-key deployments strictly worse for
> no benefit, and adds a mandatory LLM call to every search.

- **`sample` (synthetic demo data) is excluded from auto mode entirely.** Fabricated people must
  never be silently blended into a report presented as real. Needs a clear empty-state message.

### P2 · Cross-source comparability → **the crux; both axes, one list**

The three proposals genuinely conflicted here, and the disagreement is informative:

| Proposal | Position | Fatal objection |
| --- | --- | --- |
| Renormalize only | score each candidate over the criteria their source *could* answer | **launders thin data** — a lead matching 1-of-1 criteria renormalizes to 100 |
| Tier only, separate lists | group verified / profile / lead, sort within group | **violates the explicit ask** for ONE consolidated ranking |
| Renormalize + damping | `adjusted × (0.5 + 0.5·completeness)` | damping answers the laundering objection, but ignores *trust* |

**Decision: completeness and trust are orthogonal axes, and we use both — producing a single
ranked list.**

- **`dataCompleteness` (0–1)** — how much of the jobSpec the source could actually speak to.
  Derived from whether the normalized `Candidate` fields carry real signal per criterion
  (`skills.length>0`, `yearsExperience!=null`, …). *Not* string-matched against `rules.js` note
  text — that coupling was a real fragility flagged in Proposal 1's own risks.
- **`adjustedScore`** — the same weighted math as `rules.js`, restricted to the criteria the
  source could answer, so a thin candidate isn't punished by silent "no data" zeros.
- **`sourceTrust`** — a per-source prior: `verified` (sebi_ria, nmc, upload) ·
  `profile` (github, stackoverflow, google_places) · `lead` (osm, open_web).
  **Trust ≠ completeness**: an `open_web` result can have *high* completeness (the LLM filled
  every field from a portfolio page) and still be entirely unverified. This is exactly why
  completeness alone is insufficient.
- **`rankingScore` = `adjustedScore` × completenessDamp × trustFactor** — the sort key.

```js
// lib/agent/consolidate.js — ALL tunables in ONE named, documented place.
export const CONSOLIDATION_WEIGHTS = {
  completenessDamp: (c) => 0.5 + 0.5 * c,   // thin data can surface, cannot dominate
  trustFactor: { verified: 1.0, profile: 0.9, lead: 0.75 },
};
```

- **These constants are invented heuristics, not empirically derived.** They are deliberately
  collected in one exported object so they are tunable and auditable rather than scattered as
  magic numbers. This must be stated in `FAIRNESS.md`, not buried.
- **`totalScore` and `rank1to10` are computed exactly as today and left untouched** — frozen
  contract intact, existing tests unaffected. `rank1to10` shown to the recruiter derives from
  `rankingScore`, with `totalScore` still visible on the card.
- **Default view = one consolidated ranked list** (what was asked for). A **"group by
  confidence" toggle** gives Proposal 1's tiered view for recruiters who want the harder
  separation. Every card shows a trust badge + a completeness bar, so the ranking is never a
  black box.

### P3 · Deduplication → **three tiers, never merge on name alone**

1. **Auto-merge (silent, safe):** identical `sourceUrl` (normalized host+path). Effectively
   impossible to be coincidental. Keep the higher-trust record as primary, union
   `skills`/`certifications`, keep non-null scalars, record `provenance[]`.
2. **Corroborated merge (merged + flagged):** normalized-name match **plus ≥2 independent
   corroborating signals** (location overlap, ≥1 shared skill, same employer/headline token).
   Marked `mergedFrom[]` so it's auditable and reversible by eye.
3. **Flag only (never merged):** name match with <2 corroborating signals → both rows kept,
   weaker one carries `possibleDuplicateOf`. Recruiter decides.

- Name normalization: lowercase, strip honorifics (`Dr.`/`Mr.`/`Prof.`), collapse punctuation.
- **Explicitly out of scope:** phonetic/transliteration matching (`Mohammed`/`Muhammad`,
  `Bob`/`Robert`). This means the same person may appear twice, unflagged.
- **This bias is deliberate.** Under-merging yields a redundant row a human dismisses in
  seconds; over-merging silently deletes a real distinct candidate with no way to notice.

### P4 · Latency & cost → **bounded fan-out now, progress later**

- `Promise.allSettled` across ≤5 sources — wall time ≈ the slowest source, not the sum.
- **Per-source timeout guard (20s)** wrapping every `provider.search()`, since not all providers
  have internal timeouts. A timed-out source contributes zero candidates and is reported in
  `sourcesQueried` — never crashes the search.
- **Global deadline (60s)**; whatever returned by then is what gets scored.
- **`open_web` is the long pole** (its own loop is ~150s worst case). Fix: thread an optional
  `options.maxTurns` / `options.timeoutMs` into `openWeb.search()` (additive; solo defaults
  unchanged) so orchestrated runs get a **shrunk budget (3 turns)**. This is what makes it
  safe to include by default — which the product vision needs.
- **LLM call ceiling per search: ≤3** — 1 optional planning + 1 optional follow-up + 1 batched
  scoring pass. Fan-out does **not** multiply LLM calls, because `rankCandidatesLLM` already
  scores the entire merged list in a single batched call.
- **N candidates:** no per-source quota math. Each provider keeps its own internal cap;
  over-fetch → dedupe → score → trim to N at the end. N is a **ceiling, not a promise** — if
  fewer real people exist, the report says so rather than padding.
- **Progress feedback is a real gap, not deferred indefinitely.** A 60s blocking request reads
  as a hung UI and risks proxy idle-timeouts. Phase 5 converts to job-id + polling.

---

## 5. Implementation phases

Each phase is independently shippable and separately verifiable.

### Phase 1 — Orchestration core *(no UI change)*
- **Add** `lib/agent/plan.js` (`selectSources`, deterministic + optional LLM add/skip),
  `lib/agent/orchestrate.js` (fan-out, timeouts, deadline, `agentLog`),
  `lib/agent/dedupe.js`, `lib/agent/consolidate.js`.
- **Add** `POST /api/agent-search` as a **new route**, leaving `/api/search` untouched.
- **Verify:** new unit tests for dedupe (URL merge, corroborated merge, name-only *not* merged)
  and consolidate (completeness math, damping, trust ordering); existing 68 tests still green;
  curl a finance + a healthcare search and confirm multi-source merged output.

### Phase 2 — Autonomous frontend
- **Remove** the data-source card grid entirely.
- **Add** an `N candidates` control to the criteria panel; keep the CSV/JSON upload as an
  optional collapsed section.
- **Add** per-card trust badge + completeness bar; add the methodology panel
  (`sourcePlan` + `agentLog` + `sourcesQueried`) so the agent's reasoning is visible.
- **Add** the "group by confidence" view toggle.
- **Verify:** drive the real UI in the browser end-to-end; confirm no source picker remains and
  a search returns one consolidated ranked list.

### Phase 3 — Open-web reach & quality
- Thread the shrunk `maxTurns`/`timeoutMs` budget into `openWeb.search()`.
- Improve the agent prompt to search **multiple public surfaces** per run (portfolio sites,
  personal domains, public directories, GitHub/SO cross-refs) rather than one generic query.
- **Verify:** requires a `TAVILY_API_KEY` — **this is the one phase that cannot be fully
  verified without a key you must create.** Until then: verify the shrunk-budget plumbing and
  graceful-empty path only, and say so plainly.

### Phase 4 — Trust, docs, honesty
- `FAIRNESS.md`: new section on consolidation — that `CONSOLIDATION_WEIGHTS` are invented
  heuristics, that `lead`-tier rows are unverified leads needing click-through, that
  under-merging means duplicate rows, and that LinkedIn/Unstop are excluded by policy.
- `README.md`: document `/api/agent-search`, the new response fields, and the removed picker.
- Regenerate the walkthrough PDF.
- **Verify:** docs match actual behavior; full test suite green.

### Phase 5 — Progress & resilience
- Convert to `POST /api/agent-search` → `{ jobId }` + `GET /api/agent-search/:jobId` polling
  (in-memory job map, no new deps), so the UI shows live per-source progress and long searches
  survive proxy idle timeouts.
- **Verify:** a search with `open_web` enabled streams source-by-source progress and completes
  past the old 60s blocking ceiling.

### Phase 6 *(optional)* — MCP front door
- Expose `search_candidates` / `rank_candidates` as MCP tools over the same `lib/agent/` core,
  so the whole pipeline is drivable from Claude Desktop by conversation.
- **Verify:** connect via MCP client, request a ranking in chat.

---

## 6. Decisions you may want to overrule

1. **`sample` excluded from auto mode.** Fields with no real provider and no keys (sales,
   marketing, design, operations) may return **zero** results rather than fake ones. I believe
   an honest empty state beats synthetic candidates in a "real" report — but it does make those
   fields look empty until a Tavily or Google Places key exists.
2. **`open_web` included by default** (with a shrunk budget). It is the lowest-trust source;
   including it maximizes recall for fields with no registry, at some latency cost.
3. **Trust affects ranking, not just display.** A `lead` row is multiplied by 0.75, so a
   well-documented unverified find can still lose to a verified one. The alternative — display
   trust but let it not affect order — risks an LLM guess topping the list.
4. **One list by default, tiered view as a toggle.** Matches the explicit ask; the toggle exists
   for when the single list feels too permissive.

---

## 7. What this plan does *not* claim

- It does **not** reach LinkedIn, Unstop, or any login-gated platform. No phase will.
- It does **not** make `open_web` results trustworthy — they remain unverified leads requiring
  click-through, and they are ranked accordingly.
- The consolidation constants are **judgment calls, not science**, and will need tuning against
  real result sets.
- N is a **ceiling**, not a guarantee of N real people.
