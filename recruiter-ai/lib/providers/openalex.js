// lib/providers/openalex.js
//
// OpenAlex provider — finds REAL academic researchers working on the
// jobSpec's topic via the free, keyless OpenAlex API, and maps them to
// unified Candidates.
//
// QUERY STRATEGY (this matters — the obvious approach is badly wrong):
// Using `?search=<term>` on /authors performs a full-text match against the
// AUTHOR NAME, not against what the author researches. Verified live: a
// search for "machine learning" returned 20/20 NON-PEOPLE — entries like
// "CYPHER Workshop on Machine Learning for Complex Flows", "Institute for
// Machine Learning", "UCI Machine Learning Repository". Useless, and actively
// misleading, for recruiting.
//
// The correct approach is two-step:
//   1. GET /topics?search=<term>       -> resolve the term to a topic id (e.g. T12072)
//   2. GET /authors?filter=topics.id:<id>[,last_known_institutions.country_code:XX]
//      -> authors who actually PUBLISH on that topic
// Verified live: topics.id:T10320 -> 217,300 real researchers (e.g. Witold
// Pedrycz h-index 132, Jinde Cao h-index 147), each with a real institution.
//
// A defensive non-person name filter (see looksLikeOrganization) runs on top,
// because OpenAlex's author records do still contain some lab/consortium
// entries that no name-based query can fully exclude.
//
// Exports:
//   provider   { key:"openalex", label:"OpenAlex (academic authors)", fields:["research"], search(jobSpec, options) }

import { normalizeCandidate } from "../normalize.js";

const API_BASE = "https://api.openalex.org/authors";
const TOPICS_API = "https://api.openalex.org/topics";
const TIMEOUT_MS = 15_000;
const MAX_CANDIDATES = 20;
// Over-fetch, because the organization filter below discards some rows.
const PER_PAGE = 50;
// OpenAlex's own docs ask API users to identify themselves via a `mailto`
// param in exchange for faster, more reliable service ("polite pool").
const MAILTO = "agent-max@example.com";

// Small country name -> ISO-2 map for the `last_known_institutions.country_code`
// filter. Not exhaustive — extend as needed.
const COUNTRY_MAP = {
  india: "IN",
  "united states": "US",
  usa: "US",
  "u.s.": "US",
  "u.s.a.": "US",
  america: "US",
  "united kingdom": "GB",
  uk: "GB",
  britain: "GB",
  germany: "DE",
  france: "FR",
  canada: "CA",
  australia: "AU",
  china: "CN",
  japan: "JP",
  singapore: "SG",
  netherlands: "NL",
  switzerland: "CH",
  "south korea": "KR",
  korea: "KR",
  brazil: "BR",
  spain: "ES",
  italy: "IT",
};

/**
 * Map jobSpec.location to an ISO-2 country code, if recognizable.
 *
 * Smoke-tested: `last_known_institutions.display_name.search:<city>` (as
 * suggested in the task spec) is NOT a valid OpenAlex filter field — the API
 * rejects it with "Invalid query parameters error" and lists the valid
 * `last_known_institutions.*` fields, none of which support free-text name
 * search (only country_code, continent, id, ror, type, lineage,
 * is_global_south). So city-level filtering is not attempted here; only
 * country-level filtering via COUNTRY_MAP, verified working
 * (last_known_institutions.country_code:IN -> count 2,659,644). If the
 * location doesn't map to a known country, we skip location filtering
 * entirely rather than silently mismatching.
 */
function locationToCountryCode(location) {
  const key = String(location || "").trim().toLowerCase();
  return COUNTRY_MAP[key] || null;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`OpenAlex API ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function buildSearchTerms(jobSpec) {
  const skillsCriterion = (jobSpec?.criteria || []).find((c) => c.key === "skills");
  const requiredSkills = skillsCriterion?.requiredSkills || [];
  const terms = requiredSkills.filter(Boolean).join(" ");
  if (terms) return terms;
  return String(jobSpec?.title || "").trim();
}

/**
 * Resolve a free-text topic term to an OpenAlex topic id (e.g. "T12072").
 * Returns null when nothing matches, in which case the caller must NOT fall
 * back to `?search=` (see the header note — that returns organizations).
 */
async function resolveTopicId(term) {
  const params = new URLSearchParams({ search: term, "per-page": "1", mailto: MAILTO });
  const data = await fetchJson(`${TOPICS_API}?${params.toString()}`);
  const topic = Array.isArray(data?.results) ? data.results[0] : null;
  if (!topic?.id) return null;
  // topic.id is a full URL (https://openalex.org/T12072); the filter wants the bare id.
  return String(topic.id).split("/").pop();
}

// Tokens that indicate an "author" record is really a lab, consortium,
// conference, dataset, or institution rather than a person. OpenAlex mixes
// these into its author index; a recruiting tool must never present one as a
// hireable candidate.
const ORG_TOKENS = [
  "university", "institute", "institut", "college", "school", "academy",
  "laboratory", "laboratoire", "lab", "labs", "center", "centre", "department",
  "faculty", "hospital", "clinic", "foundation", "society", "association",
  "committee", "subcommittee", "council", "consortium", "network", "group",
  "team", "workshop", "conference", "symposium", "seminar", "congress",
  "proceedings", "journal", "repository", "dataset", "database", "project",
  "program", "programme", "initiative", "collaboration", "working party",
  "ltd", "llc", "inc", "gmbh", "s.l.", "corporation", "company", "agency",
  "ministry", "government", "authority", "bureau", "office", "division",
  "unit", "research group", "study group", "trial", "cohort", "biobank",
];

/**
 * Heuristic: does this author name look like an organization rather than a
 * person? Deliberately conservative in one direction — a false positive drops
 * a real researcher (recoverable, they appear via other sources), while a
 * false negative puts a conference in a candidate list (embarrassing and
 * misleading). We accept dropping some real people to guarantee the latter
 * is rare.
 */
function looksLikeOrganization(name) {
  const n = String(name || "").trim();
  if (!n) return true;
  const lower = n.toLowerCase();
  if (ORG_TOKENS.some((t) => new RegExp(`(^|[^a-z])${t}([^a-z]|$)`, "i").test(lower))) return true;
  // Person names are short; long multi-word strings are almost always entities.
  if (n.split(/\s+/).length > 5) return true;
  // "&", "/", digits, or parentheses rarely appear in a real person's name.
  if (/[&/()]|\d{2,}/.test(n)) return true;
  return false;
}

function toCandidate(author, index, countryCode = null) {
  const allInstitutions = Array.isArray(author.last_known_institutions)
    ? author.last_known_institutions.filter(Boolean)
    : [];
  // When the search was narrowed to a country, show the affiliation that
  // actually satisfies it. An author often has many institutions, and showing
  // an arbitrary first one (e.g. "Microsoft (United States)" for an author
  // matched on "Microsoft Research (India)") makes correct filtering look broken.
  const institutions = countryCode
    ? [
        ...allInstitutions.filter((i) => i.country_code === countryCode),
        ...allInstitutions.filter((i) => i.country_code !== countryCode),
      ]
    : allInstitutions;
  const topics = Array.isArray(author.topics) ? author.topics.filter(Boolean) : [];
  const hIndex = author.summary_stats?.h_index ?? null;
  const worksCount = author.works_count ?? 0;
  const citedByCount = author.cited_by_count ?? 0;

  return normalizeCandidate(
    {
      id: `openalex:${author.id}`,
      name: author.display_name,
      headline: `Academic author — h-index ${hIndex ?? "?"}, ${worksCount} works`,
      field: "research",
      // OpenAlex gives the author's institution, not a city — say so here
      // rather than treating an institution name as a location.
      location: institutions[0]?.display_name || null,
      yearsExperience: null,
      education: null,
      educationLevel: null,
      skills: topics.map((t) => t.display_name).filter(Boolean).slice(0, 8),
      certifications: [],
      summary: `${worksCount} publications, ${citedByCount} citations${
        institutions.length ? `, affiliated with ${institutions[0].display_name}` : ""
      }`,
      sourceUrl: author.id || null,
      avatarUrl: null,
      raw: {
        openAlexId: author.id,
        worksCount,
        citedByCount,
        hIndex,
        institutions: allInstitutions.map((i) => i.display_name),
      },
    },
    "openalex",
    index
  );
}

export const provider = {
  key: "openalex",
  label: "OpenAlex (academic authors)",
  fields: ["research"],

  async search(jobSpec, _options = {}) {
    try {
      const searchTerms = buildSearchTerms(jobSpec);
      if (!searchTerms) return [];

      // Step 1: term -> topic id. If the term matches no known research topic,
      // return nothing rather than degrading to a name search (which yields
      // organizations, not people — see the header note).
      const topicId = await resolveTopicId(searchTerms);
      if (!topicId) return [];

      // Step 2: authors who publish on that topic, optionally narrowed by country.
      const filters = [`topics.id:${topicId}`];
      const countryCode = locationToCountryCode(jobSpec?.location);
      if (countryCode) filters.push(`last_known_institutions.country_code:${countryCode}`);

      const params = new URLSearchParams({
        filter: filters.join(","),
        sort: "cited_by_count:desc", // most impactful researchers first
        "per-page": String(PER_PAGE),
        mailto: MAILTO,
      });

      const data = await fetchJson(`${API_BASE}?${params.toString()}`);
      const results = Array.isArray(data?.results) ? data.results : [];

      return results
        .filter((a) => !looksLikeOrganization(a?.display_name))
        .slice(0, MAX_CANDIDATES)
        .map((author, i) => toCandidate(author, i, countryCode));
    } catch (err) {
      console.warn(`[recruiter-ai] OpenAlex provider failed: ${err.message}`);
      return [];
    }
  },
};
