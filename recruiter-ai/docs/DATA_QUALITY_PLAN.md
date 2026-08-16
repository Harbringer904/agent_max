# Data-Quality Plan — preventing the "green tests, broken reality" bug class

> **Status:** proposal. The three bugs below are already FIXED; this plan is about stopping
> the *next* one, because all three shared a single root cause.

---

## 1. The three bugs, and what they have in common

| # | Bug | What the tests said | What was actually true |
| --- | --- | --- | --- |
| 1 | **Dedupe collapse** (`sebi_ria`, `nmc`) | 104 tests green, incl. 11 dedupe tests | 25 distinct SEBI advisers merged into **1**. Same for 20 NMC doctors. |
| 2 | **OpenAlex non-people** | Provider registered, integration "verified" | 20 of 20 "candidates" were conferences, institutes, and datasets. |
| 3 | **open_web fabrication** | Prompt explicitly said "never invent a person" | Invented `Tej Shah`; later attached a **real** adviser's name to a page he isn't on. |

**They are not three unrelated defects. They are one failure mode three times:**

> Every test validated *logic against fabricated inputs*. Nothing validated *behavior against
> real provider output*. So each suite proved the code did what it was told, while the code was
> being told something false about the world.

Concretely:
- **Bug 1** — the dedupe tests gave every fixture a unique `sourceUrl`, because that's the
  obvious way to write a fixture. Real registries have **no per-person URLs at all**. The rule
  "identical URL ⇒ same person" was sound logic built on a false premise.
- **Bug 2** — nothing anywhere asserted "a candidate is a *person*." `display_name` was a
  string, the shape was valid, so every check passed.
- **Bug 3** — the guarantee lived in a **prompt**, not in code. A prompt is a request, not an
  invariant. When the schema *required* a `name` and the page had none, the model complied with
  the schema and broke the instruction.

**Cost of detection:** all three were found by a human running one real query and *reading the
output*. None were found by the test suite. That is the gap to close.

---

## 2. Principles this plan enforces

1. **Verify, don't instruct.** If correctness depends on a model choosing to behave, it is not
   guaranteed. Encode it as a check. (Already applied: `nameWasSeen` grounding gate,
   `applyWeights` recomputing math locally, `plan.js` validating provider keys.)
2. **Fixtures must be captured, not imagined.** A hand-written fixture encodes the author's
   assumptions — exactly the assumptions that are wrong.
3. **Assert on meaning, not just shape.** "Is a non-empty string" is not "is a person."
4. **A provider must declare its own quirks.** Downstream code should read those, not guess.

---

## 3. Proposed work, prioritized

### P0 — `npm run doctor` (highest value, lowest cost)

A single script that queries **every** provider with a realistic jobSpec and prints a health
table. This is precisely the manual sweep that caught all three bugs — automate it.

```
provider      cand  uniqNames  uniqURLs  personLike  emptyFields  verdict
sebi_ria        25         25         1        100%          0%   OK (shared-URL registry, expected)
openalex        20         20        20         15%          0%   ⚠ non-person results
open_web         3          3         3        100%         33%   OK
```

Flags, each mapping to a bug that actually happened:
- `uniqURLs == 1 && cand > 1` → the **Bug 1** signature (non-identifying URL)
- `personLike < 80%` → the **Bug 2** signature (organizations posing as candidates)
- names absent from any fetched page → the **Bug 3** signature

**Effort:** ~half a day. **Run it before every release and after touching any provider.**

### P1 — Captured fixtures + provider contract tests

- Add `scripts/capture-fixtures.mjs` to record **real** provider responses into
  `test/fixtures/<provider>.json` (redacting nothing — this is public data).
- Add `test/providerContract.test.js` running the same invariants as `doctor`, but offline
  against those captures, so CI needs no keys and no network.
- **Invariants every provider must satisfy:** valid `Candidate` shape · `name` non-empty ·
  `source` matches the provider key · `sourceUrl` absent *or* valid URL · `yearsExperience`
  numeric-or-null (never a date string).

This is what would have caught Bug 1 *before* it shipped: the captured SEBI fixture would have
had 25 identical URLs, and a dedupe test over real data would have failed loudly.

**Effort:** ~1 day. Re-capture quarterly, or when a provider's upstream changes.

### P2 — Provider capability metadata (the structural fix)

Today `dedupe.js` *guesses* what a `sourceUrl` means. Make providers declare it:

```js
export const provider = {
  key: "sebi_ria",
  // …
  traits: {
    sourceUrlIdentifiesPerson: false,  // registry listing page, shared by every record
    dataIsLLMExtracted: false,         // true for open_web -> needs the grounding gate
    entityType: "person",              // vs "organization" (google_places, osm)
  },
};
```

Then:
- `dedupe.js` **only** URL-auto-merges when `sourceUrlIdentifiesPerson === true` — Bug 1 becomes
  structurally impossible rather than patched by a name-conflict heuristic.
- `consolidate.js` can derive trust partly from declared traits instead of a hardcoded map.
- A provider that forgets `traits` defaults to the **safest** interpretation (don't merge,
  lowest trust) — new providers can't silently inherit dangerous assumptions.

**Effort:** ~1 day across 16 providers. **This is the highest-leverage item** — it converts a
class of bug into a compile-time-ish contract.

### P3 — Person-likeness gate for people-sourced providers

Generalize the `looksLikeOrganization` heuristic currently living only in `openalex.js` into
`lib/personCheck.js`, and apply it to any provider whose `traits.entityType === "person"`.
Drop non-person rows with a logged reason (same pattern as the open_web grounding gate).

**Caveat to keep honest:** this will occasionally drop a real person with an unusual name.
That tradeoff is deliberate and must stay documented in `FAIRNESS.md` — a lost candidate is
recoverable, a conference presented as a hire is not.

**Effort:** ~half a day.

### P4 — Extend grounding beyond `name`

`nameWasSeen` currently grounds only the name. `skills`, `location`, and `summary` from
`open_web` are still ungrounded LLM output. Extend the check to at least `location`, and mark
ungrounded fields as `null` rather than dropping the whole candidate.

**Effort:** ~half a day.

---

## 4. Suggested order

```
P0 doctor script        ← do this first; it finds today's unknown bugs immediately
P2 provider traits      ← highest leverage; kills the Bug 1 class permanently
P1 captured fixtures    ← locks in the gains so CI defends them
P3 person-likeness      ← broad safety net
P4 field grounding      ← polish on the least-trusted source
```

P0 alone recovers most of the value. P0 + P2 would have prevented **all three** bugs.

---

## 5. What this plan deliberately does NOT do

- **No live-network CI.** Real API calls in CI are flaky, quota-burning, and fail for reasons
  unrelated to the change under test. Capture fixtures instead; run `doctor` manually.
- **No attempt to make `open_web` trustworthy.** It is a lead generator. The correct fix is
  accurate labeling and ranking (already done via `sourceTrust: "lead"`), not pretending
  LLM-extracted web data is verified.
- **No chasing 100% person-detection.** Heuristics will misfire in both directions; the goal is
  to make the *dangerous* direction rare and the *safe* direction documented.
