import { compareTrust } from "./trust.js";
import { traitsFor } from "../providers/traits.js";

const HONORIFICS = new Set(["dr", "mr", "mrs", "ms", "prof", "professor", "sir", "md", "phd"]);

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

// Query params that never change WHICH page/person a URL refers to: analytics
// tracking plus view-selectors (which tab, which sort, which page of results).
// Everything else is treated as identity-bearing and kept.
//
// This denylist exists because neither extreme is correct:
//   - github.com/janedoe?tab=repositories IS the same person as github.com/janedoe
//     -> the query must be ignored here
//   - news.ycombinator.com/item?id=49156686 is a DIFFERENT post from ?id=49156693
//     -> the query must be honored here
// Stripping all queries silently merged 20 distinct HN posters; keeping all
// queries split one GitHub profile into two people. So: strip the known-noise
// params, keep the rest.
const NOISE_PARAMS =
  /^(utm_|fbclid$|gclid$|msclkid$|mc_cid$|mc_eid$|ref$|referrer$|source$|tab$|sort$|order$|page$|view$|filter$|lang$|locale$|hl$)/i;

/**
 * Normalize a URL for identity comparison.
 *
 * CRITICAL: the query string is PRESERVED (minus tracking params). An earlier
 * version stripped it wholesale, which silently destroyed identity for any
 * provider whose per-person permalink lives in the query — verified live with
 * hn_hiring, where every candidate's URL is
 * `news.ycombinator.com/item?id=<commentId>`. Stripping the query collapsed 20
 * distinct people's posts to the single path `news.ycombinator.com/item`, which
 * would have auto-merged 20 real candidates into 1. Only the later name-conflict
 * guard happened to prevent the damage — accidentally, not by design. The
 * fragment (#) is still dropped: it addresses a position within one document,
 * not a different document.
 */
function normalizeUrl(url) {
  if (!isNonEmptyString(url)) return null;
  let s = url.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.replace(/^www\./, "");
  s = s.split("#")[0];

  const q = s.indexOf("?");
  let path = q >= 0 ? s.slice(0, q) : s;
  const query = q >= 0 ? s.slice(q + 1) : "";
  path = path.replace(/\/+$/, "");

  if (!query) return path || null;
  const kept = query
    .split("&")
    .filter((kv) => kv && !NOISE_PARAMS.test(kv.split("=")[0]))
    .sort();
  return (kept.length ? `${path}?${kept.join("&")}` : path) || null;
}

function normalizeName(name) {
  if (typeof name !== "string") return "";
  const s = name.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const words = s.split(/\s+/).filter(Boolean).filter((w) => !HONORIFICS.has(w));
  return words.join(" ").trim();
}

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

function unionCaseInsensitive(values) {
  const seen = new Map();
  for (const v of values) {
    if (typeof v !== "string" || !v.trim()) continue;
    const key = v.trim().toLowerCase();
    if (!seen.has(key)) seen.set(key, v.trim());
  }
  return [...seen.values()];
}

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
  let nonIdentifyingUrls = 0;
  let untrustedUrlGroups = 0;
  const afterUrlMerge = [];
  for (const members of urlGroups.values()) {
    if (members.length === 1) {
      afterUrlMerge.push(members[0]);
      continue;
    }

    if (!members.every((m) => traitsFor(m && m.source).sourceUrlIdentifiesPerson === true)) {
      afterUrlMerge.push(...members);
      untrustedUrlGroups += 1;
      continue;
    }

    const byName = new Map();
    for (const m of members) {
      const nameKey = normalizeName(m.name) || "";
      if (!byName.has(nameKey)) byName.set(nameKey, []);
      byName.get(nameKey).push(m);
    }

    if (byName.size > 1) nonIdentifyingUrls += 1;

    const unnamed = byName.get("") || [];
    const namedKeys = [...byName.keys()].filter((k) => k !== "");
    if (unnamed.length && namedKeys.length === 1) {
      byName.get(namedKeys[0]).push(...unnamed);
      byName.delete("");
    }

    for (const group of byName.values()) {
      if (group.length === 1) {
        afterUrlMerge.push(group[0]);
      } else {
        afterUrlMerge.push(mergeGroup(group, false));
        urlMergedCount += group.length - 1;
      }
    }
  }
  afterUrlMerge.push(...noUrl);
  if (untrustedUrlGroups > 0) {
    log.push(
      `dedupe: ${untrustedUrlGroups} shared url group(s) skipped for url-merge — source doesn't declare sourceUrlIdentifiesPerson`
    );
  }
  if (nonIdentifyingUrls > 0) {
    log.push(
      `dedupe: ${nonIdentifyingUrls} shared url(s) held conflicting names (registry listing page, not per-person) — not url-merged`
    );
  }

  const nameGroups = new Map();
  for (const c of afterUrlMerge) {
    const key = normalizeName(c.name);
    if (!key) {
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
