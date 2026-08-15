// lib/agent/dedupe.js
//
// PLAN_V2.md §4 P3 — three-tier deduplication across sources.
//
// Governing principle (stated in the plan): NEVER merge on name alone.
// Under-merging leaves a redundant row a human dismisses in seconds.
// Over-merging silently DELETES a real distinct candidate with no way to
// notice. This module is biased hard toward under-merging.
//
// THREE TIERS, applied in order:
//
//   1. AUTO-MERGE (silent, safe) — identical normalized sourceUrl
//      (lowercased, protocol/`www.`/query/hash/trailing-slash stripped,
//      compared as host+path). A match this specific cannot be coincidental,
//      so this tier merges regardless of name.
//
//   2. CORROBORATED MERGE (merged, but marked) — normalized-name match PLUS
//      at least 2 independent corroborating signals:
//        (a) location overlap — case-insensitive substring either direction
//        (b) at least one shared skill — case-insensitive
//        (c) a shared distinctive token in headline/summary/employer —
//            stopwords and very short tokens ignored
//      `mergedFrom` is set on the result so the merge is auditable.
//
//   3. FLAG ONLY (never merged) — name matches but fewer than 2 corroborating
//      signals. Both rows are kept; the weaker one (lower trust, tie-broken
//      by data richness) gets `possibleDuplicateOf` pointing at the id of the
//      stronger/kept row. The recruiter decides.
//
// NAME NORMALIZATION: lowercase; strip honorifics/titles (dr, mr, mrs, ms,
// prof, professor, sir, md, phd) as whole words; collapse punctuation and
// whitespace.
//
// EXPLICITLY OUT OF SCOPE: phonetic / transliteration / nickname matching
// (Mohammed vs Muhammad, Bob vs Robert). The same person CAN therefore appear
// twice, unflagged. This is an accepted, documented tradeoff — see PLAN_V2.md
// §4 P3 — not an oversight.
//
// MERGE MECHANICS: the surviving primary is the record from the more trusted
// source (compareTrust from lib/agent/trust.js), tie-broken by data richness
// (count of non-null/non-empty fields). `skills`/`certifications` are unioned
// (case-insensitive dedupe, original casing preserved from first occurrence).
// Scalars (yearsExperience, education, educationLevel, location, summary,
// headline, avatarUrl) keep the primary's value, filled from the other
// record(s) only when null/empty. `provenance` always lists every source the
// merged person came from.
//
// This module is PURE (no I/O, no network) and never throws on malformed
// input — every field access is defensive.
//
// Exports:
//   dedupeCandidates(candidates) -> { candidates: Candidate[], log: string[] }

import { compareTrust } from "./trust.js";

const HONORIFICS = new Set(["dr", "mr", "mrs", "ms", "prof", "professor", "sir", "md", "phd"]);

// Generic words that would spuriously "corroborate" almost any two people in
// the same field (job-title/company boilerplate + English stopwords). Not
// exhaustive — a heuristic, documented as such per PLAN_V2.md §4 P2/P3.
const STOPWORDS = new Set([
  "the",
  "and",
  "of",
  "in",
  "at",
  "for",
  "with",
  "a",
  "an",
  "to",
  "from",
  "on",
  "is",
  "are",
  "was",
  "were",
  "this",
  "that",
  "based",
  "work",
  "works",
  "working",
  "team",
  "company",
  "senior",
  "junior",
  "lead",
  "staff",
  "principal",
  "engineer",
  "engineering",
  "developer",
  "development",
  "manager",
  "management",
  "specialist",
  "consultant",
  "analyst",
  "associate",
  "director",
  "officer",
  "software",
  "data",
  "product",
  "technical",
  "technology",
  "university",
  "college",
  "institute",
  "school",
  "group",
  "solutions",
  "services",
  "systems",
  "technologies",
]);

const MIN_TOKEN_LEN = 4;

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

/** Lowercase; strip protocol, `www.`, query, hash, trailing slash. Returns
 * null for anything that isn't a usable string. */
function normalizeUrl(url) {
  if (!isNonEmptyString(url)) return null;
  let s = url.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.replace(/^www\./, "");
  s = s.split("#")[0].split("?")[0];
  s = s.replace(/\/+$/, "");
  return s || null;
}

/** Lowercase; strip honorifics as whole words; collapse punctuation/whitespace. */
function normalizeName(name) {
  if (typeof name !== "string") return "";
  const s = name.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const words = s.split(/\s+/).filter(Boolean).filter((w) => !HONORIFICS.has(w));
  return words.join(" ").trim();
}

/** Count of non-null/non-empty fields — used as the primary-selection tiebreaker. */
function richness(c) {
  const scalarFields = [
    c.name,
    c.headline,
    c.location,
    c.yearsExperience,
    c.education,
    c.educationLevel,
    c.summary,
    c.avatarUrl,
  ];
  let score = scalarFields.filter((v) => v !== null && v !== undefined && v !== "").length;
  if (Array.isArray(c.skills) && c.skills.length > 0) score++;
  if (Array.isArray(c.certifications) && c.certifications.length > 0) score++;
  return score;
}

/** Returns [stronger, weaker] between two candidates: more trusted source
 * wins; ties broken by data richness (higher wins); still-tied keeps `a` first. */
function orderByStrength(a, b) {
  const t = compareTrust(a && a.source, b && b.source);
  if (t > 0) return [a, b];
  if (t < 0) return [b, a];
  return richness(a) >= richness(b) ? [a, b] : [b, a];
}

function distinctiveTokens(c) {
  const employer =
    c.raw && typeof c.raw === "object"
      ? c.raw.employer || c.raw.company || c.raw.organization
      : null;
  const text = [c.headline, c.summary, employer]
    .filter((v) => typeof v === "string")
    .join(" ")
    .toLowerCase();
  const words = text.split(/[^a-z0-9]+/).filter(Boolean);
  return new Set(words.filter((w) => w.length >= MIN_TOKEN_LEN && !STOPWORDS.has(w)));
}

/** Count of independent corroborating signals between two same-name candidates. */
function corroborationCount(a, b) {
  let count = 0;

  const la = isNonEmptyString(a.location) ? a.location.trim().toLowerCase() : "";
  const lb = isNonEmptyString(b.location) ? b.location.trim().toLowerCase() : "";
  if (la && lb && (la.includes(lb) || lb.includes(la))) count++;

  const skillsA = new Set(
    (Array.isArray(a.skills) ? a.skills : [])
      .filter((s) => typeof s === "string")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  const skillsB = (Array.isArray(b.skills) ? b.skills : [])
    .filter((s) => typeof s === "string")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (skillsB.some((s) => skillsA.has(s))) count++;

  const tokensA = distinctiveTokens(a);
  const tokensB = distinctiveTokens(b);
  for (const t of tokensA) {
    if (tokensB.has(t)) {
      count++;
      break;
    }
  }

  return count;
}

/** Case-insensitive dedupe of a list of strings, preserving first-seen casing. */
function unionCaseInsensitive(values) {
  const seen = new Map();
  for (const v of values) {
    if (typeof v !== "string" || !v.trim()) continue;
    const key = v.trim().toLowerCase();
    if (!seen.has(key)) seen.set(key, v.trim());
  }
  return [...seen.values()];
}

/** Merge a group of 2+ same-person records into one. `corroborated` controls
 * whether `mergedFrom` is stamped (tier 2) or left off (tier 1, silent). */
function mergeGroup(members, corroborated) {
  let primary = members[0];
  for (let i = 1; i < members.length; i++) {
    const [stronger] = orderByStrength(primary, members[i]);
    primary = stronger;
  }
  const others = members.filter((m) => m !== primary);

  const merged = {
    ...primary,
    skills: unionCaseInsensitive(members.flatMap((m) => (Array.isArray(m.skills) ? m.skills : []))),
    certifications: unionCaseInsensitive(
      members.flatMap((m) => (Array.isArray(m.certifications) ? m.certifications : []))
    ),
  };

  const fillableFields = [
    "yearsExperience",
    "education",
    "educationLevel",
    "location",
    "summary",
    "headline",
    "avatarUrl",
  ];
  for (const field of fillableFields) {
    if (merged[field] === null || merged[field] === undefined || merged[field] === "") {
      for (const other of others) {
        const v = other[field];
        if (v !== null && v !== undefined && v !== "") {
          merged[field] = v;
          break;
        }
      }
    }
  }

  merged.provenance = members.map((m) => ({
    source: m && m.source != null ? m.source : null,
    sourceUrl: m && m.sourceUrl != null ? m.sourceUrl : null,
  }));

  if (corroborated) {
    merged.mergedFrom = members.map((m) => (m && m.id != null ? m.id : null));
  }

  return merged;
}

/**
 * @param {Array} candidates
 * @returns {{ candidates: Array, log: string[] }}
 */
export function dedupeCandidates(candidates) {
  const log = [];
  if (!Array.isArray(candidates)) return { candidates: [], log };

  const valid = candidates.filter((c) => c && typeof c === "object");

  // ---- Tier 1: identical normalized sourceUrl -> silent auto-merge ----
  const urlGroups = new Map();
  const noUrl = [];
  for (const c of valid) {
    const nu = normalizeUrl(c.sourceUrl);
    if (nu) {
      if (!urlGroups.has(nu)) urlGroups.set(nu, []);
      urlGroups.get(nu).push(c);
    } else {
      noUrl.push(c);
    }
  }

  let urlMergedCount = 0;
  const afterUrlMerge = [];
  for (const members of urlGroups.values()) {
    if (members.length === 1) {
      afterUrlMerge.push(members[0]);
    } else {
      afterUrlMerge.push(mergeGroup(members, false));
      urlMergedCount += members.length - 1;
    }
  }
  afterUrlMerge.push(...noUrl);

  // ---- Tiers 2/3: normalized-name groups -> corroborated merge or flag ----
  const nameGroups = new Map();
  for (const c of afterUrlMerge) {
    const key = normalizeName(c.name);
    if (!key) {
      // No usable name means no basis for name-based corroboration at all;
      // keep it fully isolated rather than risk grouping unnamed records.
      nameGroups.set(Symbol("noname"), [c]);
      continue;
    }
    if (!nameGroups.has(key)) nameGroups.set(key, []);
    nameGroups.get(key).push(c);
  }

  const result = [];
  let corroboratedMergedCount = 0;
  let flaggedCount = 0;

  for (const members of nameGroups.values()) {
    if (members.length === 1) {
      result.push(members[0]);
      continue;
    }

    // Union-find: connect pairs with >=2 corroborating signals.
    const parent = members.map((_, i) => i);
    const find = (x) => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };
    const union = (x, y) => {
      const rx = find(x);
      const ry = find(y);
      if (rx !== ry) parent[rx] = ry;
    };
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        if (corroborationCount(members[i], members[j]) >= 2) union(i, j);
      }
    }

    const clusters = new Map();
    for (let i = 0; i < members.length; i++) {
      const root = find(i);
      if (!clusters.has(root)) clusters.set(root, []);
      clusters.get(root).push(members[i]);
    }

    const keptRecords = [];
    for (const cluster of clusters.values()) {
      if (cluster.length === 1) {
        keptRecords.push(cluster[0]);
      } else {
        keptRecords.push(mergeGroup(cluster, true));
        corroboratedMergedCount += cluster.length - 1;
      }
    }

    if (keptRecords.length === 1) {
      result.push(keptRecords[0]);
      continue;
    }

    // Same normalized name, but fewer than 2 corroborating signals between
    // clusters -> never merge. Flag the weaker record(s) against the
    // strongest kept record in the group; the recruiter decides.
    let anchor = keptRecords[0];
    for (let i = 1; i < keptRecords.length; i++) {
      const [stronger] = orderByStrength(anchor, keptRecords[i]);
      anchor = stronger;
    }
    for (const rec of keptRecords) {
      if (rec === anchor) {
        result.push(rec);
      } else {
        flaggedCount++;
        result.push({ ...rec, possibleDuplicateOf: anchor.id != null ? anchor.id : null });
      }
    }
  }

  const mergedParts = [];
  if (urlMergedCount > 0) mergedParts.push(`${urlMergedCount} by url`);
  if (corroboratedMergedCount > 0) mergedParts.push(`${corroboratedMergedCount} corroborated`);

  let summary = "dedupe:";
  if (mergedParts.length > 0) summary += ` merged ${mergedParts.join(", ")}`;
  if (flaggedCount > 0) {
    summary += `${mergedParts.length > 0 ? "," : ""} flagged ${flaggedCount} possible duplicate${
      flaggedCount === 1 ? "" : "s"
    }`;
  }
  if (mergedParts.length === 0 && flaggedCount === 0) summary += " no duplicates found";
  log.push(summary);

  return { candidates: result, log };
}
