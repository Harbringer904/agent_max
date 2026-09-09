import { trustFor, TRUST_RANK } from "./trust.js";

export const CONSOLIDATION_WEIGHTS = {
  completenessDamp: (c) => 0.5 + 0.5 * c,
  trustFactor: { verified: 1.0, profile: 0.9, lead: 0.75 },
};

function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

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
