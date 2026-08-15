// lib/agent/consolidate.js
//
// PLAN_V2 §4 P2 — cross-source comparability. THE CRUX of the whole project.
//
// THE PROBLEM: a SEBI adviser with certs+tenure+location scores ~83 under
// lib/scoring/rules.js. An equally good person found via open_web scores ~25
// PURELY BECAUSE THE DATA IS THINNER, not because they are worse. Ranking
// them in one list on raw totalScore is misleading. But naive renormalization
// is ALSO wrong: it launders thin data — a lead matching 1-of-1 answerable
// criteria would renormalize to a perfect 100.
//
// THE DECISION: completeness and trust are ORTHOGONAL axes and we use BOTH,
// producing ONE ranked list:
//   - dataCompleteness — how much of the jobSpec the source could actually
//     speak to (weight-fraction of criteria with real data).
//   - adjustedScore    — the same weighted math as rules.js, but restricted
//     to the denominator of criteria the source could answer, so a thin
//     candidate isn't punished by silent "no data" zeros.
//   - sourceTrust       — a per-source prior from lib/agent/trust.js. Trust
//     is NOT completeness: an open_web result can be highly complete (an LLM
//     filled every field from a portfolio page) while being entirely
//     unverified. Completeness alone would let that outrank a verified
//     registry professional; trust is what prevents that.
//   - rankingScore = adjustedScore * completenessDamp(dataCompleteness)
//                    * trustFactor[sourceTrust]
//
// `totalScore` and `rank1to10` (computed by lib/scoring/rules.js or
// lib/scoring/llm.js) are FROZEN and left byte-identical — this module only
// adds fields alongside them. Pure, no I/O, never throws.
//
// Exports:
//   CONSOLIDATION_WEIGHTS         tunables, see below
//   consolidate(scoredCandidates, jobSpec) -> Scored[] (sorted by rankingScore desc)

import { trustFor, TRUST_RANK } from "./trust.js";

// ---------------------------------------------------------------------------
// CONSOLIDATION_WEIGHTS — ALL tunables in one documented, auditable place.
//
// *** THESE CONSTANTS ARE INVENTED HEURISTICS, NOT EMPIRICALLY DERIVED. ***
// They encode a judgment call ("thin data can surface but should not
// dominate", "an unverified lead should lose ~25% versus a verified source
// at equal quality") that has not been validated against real result sets.
// They are collected here specifically so they can be tuned and audited
// later rather than living as magic numbers scattered through the file.
// See PLAN_V2.md §4 P2 and FAIRNESS.md.
// ---------------------------------------------------------------------------
export const CONSOLIDATION_WEIGHTS = {
  // Damping curve applied to adjustedScore based on dataCompleteness (0..1).
  // At completeness=0 a candidate is damped to 50% of adjustedScore; at
  // completeness=1 it is undamped. Thin data can still surface, but it can
  // never fully dominate a fully-answered profile at the same adjustedScore.
  completenessDamp: (c) => 0.5 + 0.5 * c,

  // Multiplier applied per source-trust tier (see lib/agent/trust.js).
  trustFactor: { verified: 1.0, profile: 0.9, lead: 0.75 },
};

function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Whether the normalized Candidate carries real data for a given criterion
 * key. Derived directly from Candidate fields — never from string-matching
 * rules.js note text (that coupling is fragile and explicitly rejected by
 * PLAN_V2).
 */
function hasDataFor(key, candidate) {
  const c = candidate || {};
  switch (key) {
    case "skills":
      return Array.isArray(c.skills) && c.skills.length > 0;
    case "experience":
      return c.yearsExperience !== null && c.yearsExperience !== undefined;
    case "education":
      return c.educationLevel !== null && c.educationLevel !== undefined;
    case "certifications":
      return Array.isArray(c.certifications) && c.certifications.length > 0;
    case "location":
      return typeof c.location === "string" && c.location.trim() !== "";
    case "keyword": {
      const hasSummary = typeof c.summary === "string" && c.summary.trim() !== "";
      const hasHeadline = typeof c.headline === "string" && c.headline.trim() !== "";
      const hasSkills = Array.isArray(c.skills) && c.skills.length > 0;
      return hasSummary || hasHeadline || hasSkills;
    }
    default:
      return false;
  }
}

/**
 * Compute the consolidation fields for a single already-scored candidate.
 * Pure. Never throws. Every division is guarded so zero-criteria,
 * zero-criteria-with-data, missing criteriaScores, or zero-weight inputs
 * all produce finite numbers rather than NaN/Infinity.
 */
function consolidateOne(scored, jobSpec) {
  const criteria = Array.isArray(jobSpec?.criteria) ? jobSpec.criteria : [];
  const criteriaScores = scored?.criteriaScores && typeof scored.criteriaScores === "object"
    ? scored.criteriaScores
    : {};

  let totalWeight = 0;
  let answeredWeight = 0;
  let answeredWeighted = 0;

  for (const criterion of criteria) {
    const weight = Number(criterion?.weight) || 0;
    totalWeight += weight;

    if (hasDataFor(criterion?.key, scored)) {
      answeredWeight += weight;
      const entry = criteriaScores[criterion.key];
      const weighted = entry && Number.isFinite(entry.weighted) ? entry.weighted : 0;
      answeredWeighted += weighted;
    }
  }

  const dataCompleteness = totalWeight > 0 ? clamp(answeredWeight / totalWeight, 0, 1) : 0;
  const adjustedScore = answeredWeight > 0
    ? clamp((answeredWeighted / answeredWeight) * 100, 0, 100)
    : 0;

  const sourceTrust = trustFor(scored?.source);
  const trustFactor = CONSOLIDATION_WEIGHTS.trustFactor[sourceTrust] ?? CONSOLIDATION_WEIGHTS.trustFactor.lead;
  const damp = clamp(CONSOLIDATION_WEIGHTS.completenessDamp(dataCompleteness), 0, 1);

  const rankingScore = clamp(adjustedScore * damp * trustFactor, 0, 100);
  const agentRank1to10 = clamp(Math.round(rankingScore / 10), 1, 10);

  return {
    ...scored,
    dataCompleteness,
    adjustedScore,
    sourceTrust,
    rankingScore,
    agentRank1to10,
  };
}

/**
 * Post-process a list of already-scored candidates (from rankCandidates or
 * rankCandidatesLLM) into consolidated candidates ranked by rankingScore.
 * Adds new fields alongside the frozen totalScore/rank1to10 — never
 * overwrites them. Sorted by rankingScore desc, tie-broken by trust rank
 * desc, then totalScore desc. Pure, no I/O, never throws.
 */
export function consolidate(scoredCandidates, jobSpec) {
  const list = Array.isArray(scoredCandidates) ? scoredCandidates : [];
  return list
    .map((c) => consolidateOne(c, jobSpec))
    .sort((a, b) => {
      if (b.rankingScore !== a.rankingScore) return b.rankingScore - a.rankingScore;
      const trustDiff = (TRUST_RANK[b.sourceTrust] || 1) - (TRUST_RANK[a.sourceTrust] || 1);
      if (trustDiff !== 0) return trustDiff;
      return (b.totalScore || 0) - (a.totalScore || 0);
    });
}
