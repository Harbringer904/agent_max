// lib/normalize.js
//
// Field-agnostic Candidate normalizer. Pure, no I/O.
//
// Exports:
//   normalizeCandidate(partial, sourceKey, index) -> full Candidate
//   EDUCATION_LEVELS   label -> number map
//   educationLevelFromText(str) -> number|null

export const EDUCATION_LEVELS = Object.freeze({
  none: 0,
  highschool: 1,
  associate: 2,
  bachelor: 3,
  master: 4,
  doctorate: 5,
});

/**
 * Best-effort mapping from a free-text education string to an educationLevel
 * number (0 none .. 5 doctorate). Returns null when nothing recognizable is found.
 */
export function educationLevelFromText(str) {
  const text = String(str || "").toLowerCase();
  if (!text.trim()) return null;
  if (/\b(phd|ph\.d|doctor(ate)?|d\.?sc)\b/.test(text)) return EDUCATION_LEVELS.doctorate;
  if (/\b(master|msc|m\.sc|mba|m\.a|ma\b|ms\b|m\.s)\b/.test(text)) return EDUCATION_LEVELS.master;
  if (/\b(bachelor|bsc|b\.sc|ba\b|b\.a|bs\b|b\.s)\b/.test(text)) return EDUCATION_LEVELS.bachelor;
  if (/\b(associate)\b/.test(text)) return EDUCATION_LEVELS.associate;
  if (/\b(high school|highschool|diploma|ged)\b/.test(text)) return EDUCATION_LEVELS.highschool;
  return null;
}

function strOrDefault(v, fallback) {
  if (v === undefined || v === null) return fallback;
  const s = String(v).trim();
  return s || fallback;
}

function numOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function strArray(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean);
}

/**
 * Normalize a partial/raw candidate object (as produced by any provider) into
 * the frozen Candidate shape. Missing fields are filled with null/[]/{} per
 * the contract; string fields that are required (id, name, headline, field,
 * source) fall back to "" rather than null.
 *
 * @param {object} partial - raw candidate data from a provider
 * @param {string} sourceKey - provider key, becomes Candidate.source
 * @param {number} [index] - fallback used to build an id when name is absent
 */
export function normalizeCandidate(partial, sourceKey, index = 0) {
  const p = partial && typeof partial === "object" ? partial : {};

  const name = strOrDefault(p.name, "");
  const id = strOrDefault(p.id, `${sourceKey}:${name || index}`);
  const headline = strOrDefault(p.headline, "");
  const field = strOrDefault(p.field, "");

  const location = strOrDefault(p.location, null);
  const yearsExperience = numOrNull(p.yearsExperience);
  const education = strOrDefault(p.education, null);

  let educationLevel = numOrNull(p.educationLevel);
  if (educationLevel === null && education) {
    educationLevel = educationLevelFromText(education);
  }

  const skills = strArray(p.skills);
  const certifications = strArray(p.certifications);
  const summary = strOrDefault(p.summary, null);
  const sourceUrl = strOrDefault(p.sourceUrl, null);
  const avatarUrl = strOrDefault(p.avatarUrl, null);
  const raw = p.raw && typeof p.raw === "object" ? p.raw : {};

  return {
    id,
    name,
    headline,
    field,
    location,
    yearsExperience,
    education,
    educationLevel,
    skills,
    certifications,
    summary,
    source: sourceKey,
    sourceUrl,
    avatarUrl,
    raw,
  };
}
