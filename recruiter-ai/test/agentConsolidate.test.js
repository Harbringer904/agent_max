// test/agentConsolidate.test.js
//
// Unit tests for lib/agent/consolidate.js — PLAN_V2 §4 P2.

import { test } from "node:test";
import assert from "node:assert/strict";
import { consolidate, CONSOLIDATION_WEIGHTS } from "../lib/agent/consolidate.js";
import { scoreCandidate } from "../lib/scoring/rules.js";

// A baseline "empty" Candidate — tests override only the fields they need.
function baseCandidate(overrides = {}) {
  return {
    id: "c1",
    name: "Test Candidate",
    headline: "",
    field: "finance",
    location: null,
    yearsExperience: null,
    education: null,
    educationLevel: null,
    skills: [],
    certifications: [],
    summary: null,
    source: "open_web",
    sourceUrl: null,
    avatarUrl: null,
    raw: {},
    ...overrides,
  };
}

// Build a real Scored candidate via the (unchanged) rules.js engine, so
// consolidate() is exercised exactly as it composes in production.
function scored(candidateOverrides, jobSpec) {
  return scoreCandidate(baseCandidate(candidateOverrides), jobSpec);
}

// ---------------------------------------------------------------------------
// dataCompleteness math
// ---------------------------------------------------------------------------

test("dataCompleteness: all criteria answerable -> 1", () => {
  const jobSpec = {
    criteria: [
      { key: "skills", weight: 2, requiredSkills: ["python"] },
      { key: "location", weight: 2, desiredLocation: "Mumbai" },
    ],
  };
  const c = scored({ skills: ["python"], location: "Mumbai" }, jobSpec);
  const [out] = consolidate([c], jobSpec);
  assert.equal(out.dataCompleteness, 1);
});

test("dataCompleteness: half of the weight answerable -> 0.5", () => {
  const jobSpec = {
    criteria: [
      { key: "skills", weight: 2, requiredSkills: ["python"] },
      { key: "location", weight: 2, desiredLocation: "Mumbai" },
    ],
  };
  // Only skills has data; location is blank.
  const c = scored({ skills: ["python"], location: "" }, jobSpec);
  const [out] = consolidate([c], jobSpec);
  assert.equal(out.dataCompleteness, 0.5);
});

test("dataCompleteness: no data answerable -> 0", () => {
  const jobSpec = {
    criteria: [
      { key: "skills", weight: 2, requiredSkills: ["python"] },
      { key: "location", weight: 2, desiredLocation: "Mumbai" },
    ],
  };
  const c = scored({ skills: [], location: "" }, jobSpec);
  const [out] = consolidate([c], jobSpec);
  assert.equal(out.dataCompleteness, 0);
});

// ---------------------------------------------------------------------------
// adjustedScore ignores criteria the source could not answer
// ---------------------------------------------------------------------------

test("adjustedScore: thin candidate is not punished for criteria the source never answered", () => {
  const jobSpec = {
    criteria: [
      { key: "skills", weight: 1, requiredSkills: ["python"] },
      { key: "location", weight: 1, desiredLocation: "Mumbai" },
    ],
  };
  // Perfect match on the one thing this source can speak to (skills);
  // location is simply absent from the data, not a bad match.
  const c = scored({ skills: ["python"], location: "" }, jobSpec);
  const [out] = consolidate([c], jobSpec);
  // totalScore (rules.js, unaware of completeness) is dragged to 50 by the
  // unanswered location criterion counting as a hard zero.
  assert.equal(c.totalScore, 50);
  // adjustedScore restricts the denominator to what the source could
  // answer, so the perfect skills match is not diluted by the blank field.
  assert.equal(out.adjustedScore, 100);
});

// ---------------------------------------------------------------------------
// THE LAUNDERING GUARD
// ---------------------------------------------------------------------------

test("laundering guard: a thin lead with 1-of-6 answered (even perfectly) must not outrank a fuller verified candidate", () => {
  const jobSpec = {
    criteria: [
      { key: "skills", weight: 1, requiredSkills: ["python", "sql"] },
      { key: "experience", weight: 1, minYears: 3 },
      { key: "education", weight: 1, minEducationLevel: 3 },
      { key: "certifications", weight: 1, requiredCerts: ["CFA", "FRM"] },
      { key: "location", weight: 1, desiredLocation: "Mumbai" },
      { key: "keyword", weight: 1, keywords: ["fintech"] },
    ],
  };

  // Lead: only "experience" is answerable, and it's a perfect answer.
  // Everything else (skills/education/certs/location/summary+headline) is
  // blank, so skills/keyword/etc. all register as unanswered too.
  const lead = scored(
    {
      source: "open_web", // trust tier: lead
      yearsExperience: 50,
      skills: [],
      educationLevel: null,
      certifications: [],
      location: "",
      summary: "",
      headline: "",
    },
    jobSpec,
  );

  // Verified: full data on every criterion, but an imperfect (not maxed) score.
  const verified = scored(
    {
      source: "sebi_ria", // trust tier: verified
      skills: ["python", "sql"],
      yearsExperience: 2, // below minYears=3 -> raw 2/3
      educationLevel: 4,
      certifications: ["CFA"], // matched 1/2 required
      location: "Mumbai",
      summary: "Fintech professional",
      headline: "Fintech advisor",
    },
    jobSpec,
  );

  const [leadOut, verifiedOut] = consolidate([lead, verified], jobSpec).sort((a, b) =>
    a.source === "open_web" ? -1 : 1,
  );

  // Naively renormalizing the lead's single answerable criterion "launders"
  // it to a perfect adjustedScore...
  assert.equal(leadOut.adjustedScore, 100);
  assert.ok(leadOut.dataCompleteness < 0.2, "lead completeness should be thin");
  // ...but the verified candidate, despite an imperfect score, still wins
  // the actual ranking once damping + trust are applied.
  assert.ok(
    verifiedOut.rankingScore > leadOut.rankingScore,
    `expected verified (${verifiedOut.rankingScore}) > lead (${leadOut.rankingScore})`,
  );

  // Cross-check the ranked order consolidate() itself returns.
  const ranked = consolidate([lead, verified], jobSpec);
  assert.equal(ranked[0].source, "sebi_ria");
  assert.equal(ranked[1].source, "open_web");
});

// ---------------------------------------------------------------------------
// Trust ordering
// ---------------------------------------------------------------------------

test("trust ordering: identical adjustedScore + completeness -> verified > profile > lead", () => {
  const jobSpec = {
    criteria: [{ key: "skills", weight: 1, requiredSkills: ["python"] }],
  };
  const leadC = scored({ source: "osm", skills: ["python"] }, jobSpec);
  const profileC = scored({ source: "github", skills: ["python"] }, jobSpec);
  const verifiedC = scored({ source: "sebi_ria", skills: ["python"] }, jobSpec);

  const ranked = consolidate([leadC, profileC, verifiedC], jobSpec);

  assert.equal(ranked[0].source, "sebi_ria");
  assert.equal(ranked[1].source, "github");
  assert.equal(ranked[2].source, "osm");

  // All three had identical adjustedScore/completeness — only trust differs.
  assert.equal(ranked[0].adjustedScore, ranked[1].adjustedScore);
  assert.equal(ranked[1].adjustedScore, ranked[2].adjustedScore);
  assert.equal(ranked[0].dataCompleteness, ranked[1].dataCompleteness);
});

// ---------------------------------------------------------------------------
// Frozen contract: totalScore / rank1to10 untouched
// ---------------------------------------------------------------------------

test("totalScore and rank1to10 are byte-identical before and after consolidate()", () => {
  const jobSpec = {
    criteria: [
      { key: "skills", weight: 3, requiredSkills: ["python", "sql"] },
      { key: "experience", weight: 2, minYears: 5 },
    ],
  };
  const c = scored({ skills: ["python"], yearsExperience: 3 }, jobSpec);
  const before = { totalScore: c.totalScore, rank1to10: c.rank1to10 };

  const [out] = consolidate([c], jobSpec);

  assert.equal(out.totalScore, before.totalScore);
  assert.equal(out.rank1to10, before.rank1to10);
  // New fields exist alongside, not instead of.
  assert.ok("rankingScore" in out);
  assert.ok("agentRank1to10" in out);
});

// ---------------------------------------------------------------------------
// Guard: every division, no NaN/Infinity
// ---------------------------------------------------------------------------

test("zero criteria -> finite numbers, no NaN", () => {
  const jobSpec = { criteria: [] };
  const c = scored({}, jobSpec);
  const [out] = consolidate([c], jobSpec);
  assert.equal(out.dataCompleteness, 0);
  assert.equal(out.adjustedScore, 0);
  assert.equal(out.rankingScore, 0);
  assert.ok(Number.isFinite(out.dataCompleteness));
  assert.ok(Number.isFinite(out.adjustedScore));
  assert.ok(Number.isFinite(out.rankingScore));
  assert.ok(Number.isFinite(out.agentRank1to10));
  assert.equal(out.agentRank1to10, 1); // clamped to floor
});

test("zero criteria answerable (all present but blank data) -> finite numbers, no NaN", () => {
  const jobSpec = {
    criteria: [
      { key: "skills", weight: 5, requiredSkills: ["python"] },
      { key: "certifications", weight: 5, requiredCerts: ["CFA"] },
    ],
  };
  const c = scored({ skills: [], certifications: [] }, jobSpec);
  const [out] = consolidate([c], jobSpec);
  assert.equal(out.dataCompleteness, 0);
  assert.equal(out.adjustedScore, 0);
  assert.equal(out.rankingScore, 0);
  assert.ok(Number.isFinite(out.rankingScore));
});

test("missing criteriaScores entirely -> finite numbers, no throw", () => {
  const jobSpec = {
    criteria: [{ key: "skills", weight: 1, requiredSkills: ["python"] }],
  };
  // A hand-built "scored" object that skipped rules.js scoring but still has
  // real Candidate data (skills present) — criteriaScores is absent.
  const malformed = {
    id: "x",
    source: "github",
    skills: ["python"],
    totalScore: 50,
    rank1to10: 5,
  };
  assert.doesNotThrow(() => consolidate([malformed], jobSpec));
  const [out] = consolidate([malformed], jobSpec);
  assert.ok(Number.isFinite(out.adjustedScore));
  assert.ok(Number.isFinite(out.rankingScore));
  assert.equal(out.adjustedScore, 0); // no weighted entry to read -> defaults to 0
});

test("weight-0 criterion never divides by zero", () => {
  const jobSpec = { criteria: [{ key: "skills", weight: 0, requiredSkills: ["python"] }] };
  const c = scored({ skills: ["python"] }, jobSpec);
  const [out] = consolidate([c], jobSpec);
  assert.ok(Number.isFinite(out.dataCompleteness));
  assert.ok(Number.isFinite(out.adjustedScore));
  assert.ok(Number.isFinite(out.rankingScore));
});

test("empty candidate list returns empty array", () => {
  assert.deepEqual(consolidate([], { criteria: [] }), []);
});

// ---------------------------------------------------------------------------
// CONSOLIDATION_WEIGHTS shape (auditability contract)
// ---------------------------------------------------------------------------

test("CONSOLIDATION_WEIGHTS exposes the documented tunables", () => {
  assert.equal(typeof CONSOLIDATION_WEIGHTS.completenessDamp, "function");
  assert.equal(CONSOLIDATION_WEIGHTS.completenessDamp(0), 0.5);
  assert.equal(CONSOLIDATION_WEIGHTS.completenessDamp(1), 1);
  assert.deepEqual(CONSOLIDATION_WEIGHTS.trustFactor, { verified: 1.0, profile: 0.9, lead: 0.75 });
});
