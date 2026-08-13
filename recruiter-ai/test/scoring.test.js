// test/scoring.test.js
//
// Unit tests for lib/scoring/rules.js — asserts REAL current behavior.

import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreCandidate, rankCandidates, skillMatches } from "../lib/scoring/rules.js";

// ---------------------------------------------------------------------------
// skillMatches — word-boundary-aware matching
// ---------------------------------------------------------------------------

test("skillMatches: 'go' does not match inside 'google'", () => {
  assert.equal(skillMatches("go", "I use google every day"), false);
  assert.equal(skillMatches("go", ["googler"]), false);
});

test("skillMatches: 'go' matches as a whole token", () => {
  assert.equal(skillMatches("go", "I write go and python"), true);
  assert.equal(skillMatches("go", ["go", "python"]), true);
});

test("skillMatches: 'c++' matches as a whole token (special regex chars escaped)", () => {
  assert.equal(skillMatches("c++", "Experienced C++ developer"), true);
  assert.equal(skillMatches("c++", ["C++"]), true);
  assert.equal(skillMatches("c++", "experienced in c developer"), false);
});

test("skillMatches: 'node.js' matches as a whole token", () => {
  assert.equal(skillMatches("node.js", "Built APIs with Node.js and Express"), true);
  assert.equal(skillMatches("node.js", ["Node.js"]), true);
});

test("skillMatches: empty term/haystack returns false", () => {
  assert.equal(skillMatches("", "anything"), false);
  assert.equal(skillMatches("python", ""), false);
  assert.equal(skillMatches("python", []), false);
});

test("skillMatches: exact-array-element match short-circuits the regex path", () => {
  // haystack element equal (case-insensitive) to term matches even if it would
  // otherwise contain boundary-breaking characters when joined.
  assert.equal(skillMatches("C#", ["C#"]), true);
});

// ---------------------------------------------------------------------------
// Per-criterion raw computation (via scoreCandidate)
// ---------------------------------------------------------------------------

test("skills criterion: raw is matched/required ratio", () => {
  const jobSpec = {
    criteria: [{ key: "skills", label: "Skills", weight: 4, requiredSkills: ["python", "sql"] }],
  };
  const candidate = { skills: ["python", "react"] };
  const scored = scoreCandidate(candidate, jobSpec);
  assert.equal(scored.criteriaScores.skills.raw, 0.5);
  assert.equal(scored.criteriaScores.skills.weighted, 2);
  assert.equal(scored.criteriaScores.skills.max, 4);
  assert.match(scored.criteriaScores.skills.note, /matched 1\/2/);
});

test("skills criterion: no required skills specified -> raw 0", () => {
  const jobSpec = { criteria: [{ key: "skills", weight: 3, requiredSkills: [] }] };
  const scored = scoreCandidate({ skills: ["python"] }, jobSpec);
  assert.equal(scored.criteriaScores.skills.raw, 0);
  assert.match(scored.criteriaScores.skills.note, /no required skills specified/);
});

test("skills criterion: candidate has no skills data -> raw 0", () => {
  const jobSpec = { criteria: [{ key: "skills", weight: 3, requiredSkills: ["python"] }] };
  const scored = scoreCandidate({ skills: [] }, jobSpec);
  assert.equal(scored.criteriaScores.skills.raw, 0);
  assert.match(scored.criteriaScores.skills.note, /no skills data/);
});

test("experience criterion: raw clamps at 1 when candidate exceeds minYears", () => {
  const jobSpec = { criteria: [{ key: "experience", weight: 2, minYears: 5 }] };
  const scored = scoreCandidate({ yearsExperience: 20 }, jobSpec);
  assert.equal(scored.criteriaScores.experience.raw, 1);
});

test("experience criterion: raw is proportional below minYears", () => {
  const jobSpec = { criteria: [{ key: "experience", weight: 2, minYears: 10 }] };
  const scored = scoreCandidate({ yearsExperience: 5 }, jobSpec);
  assert.equal(scored.criteriaScores.experience.raw, 0.5);
});

test("experience criterion: null yearsExperience -> raw 0", () => {
  const jobSpec = { criteria: [{ key: "experience", weight: 2, minYears: 5 }] };
  const scored = scoreCandidate({ yearsExperience: null }, jobSpec);
  assert.equal(scored.criteriaScores.experience.raw, 0);
  assert.match(scored.criteriaScores.experience.note, /no experience data/);
});

test("experience criterion: no/zero minYears -> raw 1 (no minimum required)", () => {
  const jobSpec = { criteria: [{ key: "experience", weight: 2, minYears: 0 }] };
  const scored = scoreCandidate({ yearsExperience: 3 }, jobSpec);
  assert.equal(scored.criteriaScores.experience.raw, 1);
  assert.match(scored.criteriaScores.experience.note, /no minimum years required/);
});

test("education criterion: raw is level ratio below minimum, 1 at/above minimum", () => {
  const jobSpec = { criteria: [{ key: "education", weight: 2, minEducationLevel: 4 }] };
  const below = scoreCandidate({ educationLevel: 2 }, jobSpec);
  const atMin = scoreCandidate({ educationLevel: 4 }, jobSpec);
  const above = scoreCandidate({ educationLevel: 5 }, jobSpec);
  assert.equal(below.criteriaScores.education.raw, 0.5);
  assert.equal(atMin.criteriaScores.education.raw, 1);
  assert.equal(above.criteriaScores.education.raw, 1);
});

test("education criterion: null educationLevel -> raw 0", () => {
  const jobSpec = { criteria: [{ key: "education", weight: 2, minEducationLevel: 3 }] };
  const scored = scoreCandidate({ educationLevel: null }, jobSpec);
  assert.equal(scored.criteriaScores.education.raw, 0);
  assert.match(scored.criteriaScores.education.note, /no education data/);
});

test("education criterion: no minimum required -> raw 1", () => {
  const jobSpec = { criteria: [{ key: "education", weight: 2, minEducationLevel: 0 }] };
  const scored = scoreCandidate({ educationLevel: 1 }, jobSpec);
  assert.equal(scored.criteriaScores.education.raw, 1);
});

test("certifications criterion: raw is matched/required ratio", () => {
  const jobSpec = {
    criteria: [{ key: "certifications", weight: 2, requiredCerts: ["AWS", "GCP"] }],
  };
  const scored = scoreCandidate({ certifications: ["AWS Certified Solutions Architect"] }, jobSpec);
  assert.equal(scored.criteriaScores.certifications.raw, 0.5);
  assert.match(scored.criteriaScores.certifications.note, /matched 1\/2/);
});

test("certifications criterion: no certification data -> raw 0", () => {
  const jobSpec = { criteria: [{ key: "certifications", weight: 2, requiredCerts: ["AWS"] }] };
  const scored = scoreCandidate({ certifications: [] }, jobSpec);
  assert.equal(scored.criteriaScores.certifications.raw, 0);
  assert.match(scored.criteriaScores.certifications.note, /no certification data/);
});

test("location criterion: matches when candidate location contains desired location", () => {
  const jobSpec = { criteria: [{ key: "location", weight: 1, desiredLocation: "Austin" }] };
  const scored = scoreCandidate({ location: "Austin, TX" }, jobSpec);
  assert.equal(scored.criteriaScores.location.raw, 1);
});

test("location criterion: matches when desired location contains candidate location (either direction)", () => {
  const jobSpec = {
    criteria: [{ key: "location", weight: 1, desiredLocation: "downtown austin" }],
  };
  const scored = scoreCandidate({ location: "Austin" }, jobSpec);
  assert.equal(scored.criteriaScores.location.raw, 1);
});

test("location criterion: mismatch -> raw 0", () => {
  const jobSpec = { criteria: [{ key: "location", weight: 1, desiredLocation: "Austin" }] };
  const scored = scoreCandidate({ location: "Seattle, WA" }, jobSpec);
  assert.equal(scored.criteriaScores.location.raw, 0);
  assert.match(scored.criteriaScores.location.note, /location mismatch/);
});

test("location criterion: no desired location specified -> raw 0", () => {
  const jobSpec = { criteria: [{ key: "location", weight: 1, desiredLocation: "" }] };
  const scored = scoreCandidate({ location: "Austin" }, jobSpec);
  assert.equal(scored.criteriaScores.location.raw, 0);
  assert.match(scored.criteriaScores.location.note, /no desired location specified/);
});

test("location criterion: no candidate location data -> raw 0", () => {
  const jobSpec = { criteria: [{ key: "location", weight: 1, desiredLocation: "Austin" }] };
  const scored = scoreCandidate({ location: null }, jobSpec);
  assert.equal(scored.criteriaScores.location.raw, 0);
  assert.match(scored.criteriaScores.location.note, /no location data/);
});

test("keyword criterion: matches over summary + skills + headline combined", () => {
  const jobSpec = {
    criteria: [{ key: "keyword", weight: 2, keywords: ["leadership", "mentoring"] }],
  };
  const inSummary = scoreCandidate(
    { summary: "Proven leadership track record", skills: [], headline: "" },
    jobSpec
  );
  const inSkills = scoreCandidate(
    { summary: "", skills: ["leadership"], headline: "" },
    jobSpec
  );
  const inHeadline = scoreCandidate(
    { summary: "", skills: [], headline: "Engineering leadership" },
    jobSpec
  );
  assert.equal(inSummary.criteriaScores.keyword.raw, 0.5);
  assert.equal(inSkills.criteriaScores.keyword.raw, 0.5);
  assert.equal(inHeadline.criteriaScores.keyword.raw, 0.5);
});

test("keyword criterion: no keywords specified -> raw 0", () => {
  const jobSpec = { criteria: [{ key: "keyword", weight: 1, keywords: [] }] };
  const scored = scoreCandidate({ summary: "leadership" }, jobSpec);
  assert.equal(scored.criteriaScores.keyword.raw, 0);
  assert.match(scored.criteriaScores.keyword.note, /no keywords specified/);
});

test("keyword criterion: no summary/skills/headline data -> raw 0", () => {
  const jobSpec = { criteria: [{ key: "keyword", weight: 1, keywords: ["leadership"] }] };
  const scored = scoreCandidate({ summary: null, skills: [], headline: "" }, jobSpec);
  assert.equal(scored.criteriaScores.keyword.raw, 0);
  assert.match(scored.criteriaScores.keyword.note, /no summary\/skills\/headline data/);
});

test("unknown criterion key -> raw 0 with descriptive note", () => {
  const jobSpec = { criteria: [{ key: "bogus", weight: 1 }] };
  const scored = scoreCandidate({}, jobSpec);
  assert.equal(scored.criteriaScores.bogus.raw, 0);
  assert.match(scored.criteriaScores.bogus.note, /unknown criterion key "bogus"/);
});

// ---------------------------------------------------------------------------
// totalScore normalization / rank1to10 clamp / divide-by-zero guard
// ---------------------------------------------------------------------------

test("scoreCandidate: totalScore is normalized (sum weighted / sum max) * 100, rank1to10 derived", () => {
  const jobSpec = {
    criteria: [
      { key: "skills", weight: 4, requiredSkills: ["python", "sql"] }, // raw .5 -> weighted 2, max 4
      { key: "experience", weight: 2, minYears: 10 }, // raw .5 -> weighted 1, max 2
      { key: "education", weight: 2, minEducationLevel: 4 }, // raw .5 -> weighted 1, max 2
      { key: "certifications", weight: 2, requiredCerts: ["AWS", "GCP"] }, // raw .5 -> weighted 1, max 2
      { key: "location", weight: 1, desiredLocation: "Austin" }, // raw 1 -> weighted 1, max 1
      { key: "keyword", weight: 2, keywords: ["leadership", "mentoring"] }, // raw .5 -> weighted 1, max 2
    ],
  };
  const candidate = {
    skills: ["python"],
    yearsExperience: 5,
    educationLevel: 2,
    certifications: ["AWS"],
    location: "Austin, TX",
    summary: "Proven leadership track record",
    headline: "",
  };
  const scored = scoreCandidate(candidate, jobSpec);
  // sumWeighted = 2+1+1+1+1+1 = 7, sumMax = 4+2+2+2+1+2 = 13
  assert.equal(scored.totalScore, 53.85);
  assert.equal(scored.rank1to10, 5);
});

test("rank1to10 clamps to [1,10] at the extremes", () => {
  const zeroJobSpec = { criteria: [{ key: "skills", weight: 1, requiredSkills: ["python"] }] };
  const zeroScored = scoreCandidate({ skills: [] }, zeroJobSpec);
  assert.equal(zeroScored.totalScore, 0);
  assert.equal(zeroScored.rank1to10, 1); // clamp(round(0/10),1,10) = 1, not 0

  const perfectJobSpec = { criteria: [{ key: "skills", weight: 1, requiredSkills: ["python"] }] };
  const perfectScored = scoreCandidate({ skills: ["python"] }, perfectJobSpec);
  assert.equal(perfectScored.totalScore, 100);
  assert.equal(perfectScored.rank1to10, 10);
});

test("empty criteria array -> totalScore 0 (divide-by-zero guard), rank1to10 clamps to 1", () => {
  const scored = scoreCandidate({ skills: ["python"] }, { criteria: [] });
  assert.deepEqual(scored.criteriaScores, {});
  assert.equal(scored.totalScore, 0);
  assert.equal(scored.rank1to10, 1);
});

test("missing jobSpec.criteria -> treated as empty array", () => {
  const scored = scoreCandidate({ skills: ["python"] }, {});
  assert.deepEqual(scored.criteriaScores, {});
  assert.equal(scored.totalScore, 0);
});

// ---------------------------------------------------------------------------
// rankCandidates — sort desc + topN slice
// ---------------------------------------------------------------------------

test("rankCandidates: sorts by totalScore descending and slices to topN", () => {
  const jobSpec = { criteria: [{ key: "skills", weight: 1, requiredSkills: ["python", "sql", "react"] }] };
  const candidates = [
    { id: "low", skills: [] }, // 0/3 -> 0
    { id: "high", skills: ["python", "sql", "react"] }, // 3/3 -> 100
    { id: "mid", skills: ["python"] }, // 1/3 -> 33.33
  ];
  const ranked = rankCandidates(candidates, jobSpec, 2);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].id, "high");
  assert.equal(ranked[1].id, "mid");
});

test("rankCandidates: defaults topN to 25 and handles non-array input", () => {
  assert.deepEqual(rankCandidates(null, { criteria: [] }), []);
  assert.deepEqual(rankCandidates(undefined, { criteria: [] }), []);
  const many = Array.from({ length: 30 }, (_, i) => ({ id: i, skills: [] }));
  const ranked = rankCandidates(many, { criteria: [] });
  assert.equal(ranked.length, 25);
});
