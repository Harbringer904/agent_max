// lib/scoring/rules.js
//
// Field-agnostic, deterministic weighted scoring engine. Pure — no I/O.
//
// Exports:
//   scoreCandidate(candidate, jobSpec)             -> Scored candidate
//   rankCandidates(candidates, jobSpec, topN=25)    -> Scored candidate[]
//   skillMatches(term, haystackArrayOrString)       -> boolean

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Case-insensitive, word-boundary-aware match of `term` against `haystack`,
 * which may be an array of strings (e.g. candidate.skills) or a single
 * string (e.g. free text). Boundary characters are anything other than
 * letters/digits/+/#/. so "go" does not match inside "google", but
 * "c++" and "node.js" still match as whole tokens.
 */
export function skillMatches(term, haystack) {
  const t = String(term || "").toLowerCase().trim();
  if (!t) return false;

  let text;
  if (Array.isArray(haystack)) {
    if (haystack.some((h) => String(h).toLowerCase().trim() === t)) return true;
    text = haystack.join(" ");
  } else {
    text = String(haystack || "");
  }
  text = text.toLowerCase();
  if (!text.trim()) return false;

  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const boundary = "[^a-z0-9+#.]";
  return new RegExp(`(?:^|${boundary})${escaped}(?:${boundary}|$)`, "i").test(text);
}

function skillsRaw(criterion, candidate) {
  const required = Array.isArray(criterion.requiredSkills) ? criterion.requiredSkills : [];
  if (!required.length) return { raw: 0, note: "no required skills specified" };
  const candidateSkills = Array.isArray(candidate.skills) ? candidate.skills : [];
  if (!candidateSkills.length) return { raw: 0, note: "no skills data" };
  const matched = required.filter((s) => skillMatches(s, candidateSkills));
  return { raw: matched.length / required.length, note: `matched ${matched.length}/${required.length} required skills` };
}

function experienceRaw(criterion, candidate) {
  const minYears = Number(criterion.minYears);
  if (candidate.yearsExperience === null || candidate.yearsExperience === undefined) {
    return { raw: 0, note: "no experience data" };
  }
  if (!Number.isFinite(minYears) || minYears <= 0) {
    return { raw: 1, note: "no minimum years required" };
  }
  const raw = clamp01(candidate.yearsExperience / minYears);
  return { raw, note: `${candidate.yearsExperience} yrs vs ${minYears} required` };
}

function educationRaw(criterion, candidate) {
  const min = Number(criterion.minEducationLevel);
  if (candidate.educationLevel === null || candidate.educationLevel === undefined) {
    return { raw: 0, note: "no education data" };
  }
  if (!Number.isFinite(min) || min <= 0) {
    return { raw: 1, note: "no minimum education required" };
  }
  const raw = candidate.educationLevel >= min ? 1 : candidate.educationLevel / min;
  return { raw: clamp01(raw), note: `education level ${candidate.educationLevel} vs ${min} required` };
}

function certificationsRaw(criterion, candidate) {
  const required = Array.isArray(criterion.requiredCerts) ? criterion.requiredCerts : [];
  if (!required.length) return { raw: 0, note: "no required certifications specified" };
  const candidateCerts = Array.isArray(candidate.certifications) ? candidate.certifications : [];
  if (!candidateCerts.length) return { raw: 0, note: "no certification data" };
  const matched = required.filter((c) => skillMatches(c, candidateCerts));
  return { raw: matched.length / required.length, note: `matched ${matched.length}/${required.length} required certifications` };
}

function locationRaw(criterion, candidate) {
  const wanted = String(criterion.desiredLocation || "").toLowerCase().trim();
  if (!wanted) return { raw: 0, note: "no desired location specified" };
  const have = String(candidate.location || "").toLowerCase().trim();
  if (!have) return { raw: 0, note: "no location data" };
  const raw = have.includes(wanted) || wanted.includes(have) ? 1 : 0;
  return { raw, note: raw ? "location match" : "location mismatch" };
}

function keywordRaw(criterion, candidate) {
  const keywords = Array.isArray(criterion.keywords) ? criterion.keywords : [];
  if (!keywords.length) return { raw: 0, note: "no keywords specified" };
  const haystack = [
    candidate.summary || "",
    Array.isArray(candidate.skills) ? candidate.skills.join(" ") : "",
    candidate.headline || "",
  ].join(" ");
  if (!haystack.trim()) return { raw: 0, note: "no summary/skills/headline data" };
  const matched = keywords.filter((k) => skillMatches(k, haystack));
  return { raw: matched.length / keywords.length, note: `matched ${matched.length}/${keywords.length} keywords` };
}

function computeRaw(criterion, candidate) {
  switch (criterion.key) {
    case "skills":
      return skillsRaw(criterion, candidate);
    case "experience":
      return experienceRaw(criterion, candidate);
    case "education":
      return educationRaw(criterion, candidate);
    case "certifications":
      return certificationsRaw(criterion, candidate);
    case "location":
      return locationRaw(criterion, candidate);
    case "keyword":
      return keywordRaw(criterion, candidate);
    default:
      return { raw: 0, note: `unknown criterion key "${criterion.key}"` };
  }
}

/**
 * Score a single candidate against a JobSpec's weighted criteria.
 * Returns { ...candidate, criteriaScores, totalScore, rank1to10 }.
 */
export function scoreCandidate(candidate, jobSpec) {
  const criteria = Array.isArray(jobSpec?.criteria) ? jobSpec.criteria : [];
  const criteriaScores = {};
  let sumWeighted = 0;
  let sumMax = 0;

  for (const criterion of criteria) {
    const weight = Number(criterion.weight) || 0;
    const { raw, note } = computeRaw(criterion, candidate);
    const weighted = round2(raw * weight);
    const max = weight;

    criteriaScores[criterion.key] = { raw: round2(raw), weighted, max, note };
    sumWeighted += weighted;
    sumMax += max;
  }

  const totalScore = sumMax > 0 ? round2((sumWeighted / sumMax) * 100) : 0;
  const rank1to10 = Math.max(1, Math.min(10, Math.round(totalScore / 10)));

  return { ...candidate, criteriaScores, totalScore, rank1to10 };
}

/**
 * Score all candidates against a JobSpec, sort best-first, return top N.
 */
export function rankCandidates(candidates, jobSpec, topN = 25) {
  return (Array.isArray(candidates) ? candidates : [])
    .map((c) => scoreCandidate(c, jobSpec))
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, topN);
}
