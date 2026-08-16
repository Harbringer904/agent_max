// lib/providers/finraBrokerCheck.js
//
// FINRA BrokerCheck provider — LIVE queries against the official US
// financial-industry regulator's public registry of FINRA-registered
// representatives. Free, no key.
//
// IMPORTANT — this API is a NAME/FIRM full-text search, not a location
// search. There is no "search by city" endpoint. We derive the query text
// from jobSpec.location (a city name often also matches firm/branch text)
// or fall back to jobSpec.title, then post-filter the results against each
// hit's own employment/branch fields when that data is present — so the
// location filtering here is approximate by construction, not a bug.
//
// Exports:
//   provider   { key:"finra", label, fields:["finance"], search(jobSpec, options) }

import { normalizeCandidate } from "../normalize.js";

const API_BASE = "https://api.brokercheck.finra.org/search/individual";
const TIMEOUT_MS = 15_000;
const MAX_CANDIDATES = 20;

/** Derive the full-text search query. Prefers location (city names often
 * match firm/branch text in this index) over title. Null if neither exists,
 * so the caller can bail out rather than sending a meaningless query. */
function deriveQuery(jobSpec) {
  const location = String(jobSpec?.location || "").trim();
  if (location) return location.split(",")[0].trim(); // "Austin, TX" -> "Austin"
  const title = String(jobSpec?.title || "").trim();
  if (title) return title;
  return null;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`FINRA BrokerCheck API ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function titleCase(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** True when jobSpec.location isn't set (nothing to filter on), when the hit
 * has no employment records to check (can't verify either way — keep it),
 * or when at least one employment's branch city/state matches. */
function locationMatchesEmployments(wanted, employments) {
  const w = String(wanted || "").trim().toLowerCase();
  if (!w) return true;
  if (!Array.isArray(employments) || employments.length === 0) return true;
  return employments.some((e) => {
    const city = String(e?.branch_city || "").toLowerCase();
    const state = String(e?.branch_state || "").toLowerCase();
    return (city && (city.includes(w) || w.includes(city))) || (state && w.includes(state));
  });
}

function toCandidate(hit, index) {
  const s = hit._source || {};
  const employments = Array.isArray(s.ind_current_employments) ? s.ind_current_employments : [];

  const name = titleCase([s.ind_firstname, s.ind_middlename, s.ind_lastname].filter(Boolean).join(" "));
  const industryDays = Number(s.ind_industry_days);
  const yearsExperience = Number.isFinite(industryDays) ? Math.floor(industryDays / 365.25) : null;

  const firstEmployment = employments[0] || null;
  const location = firstEmployment
    ? [firstEmployment.branch_city, firstEmployment.branch_state].filter(Boolean).join(", ") || null
    : null;

  const skills = ["securities", "investment advisory"];
  if (s.ind_bc_scope && s.ind_bc_scope !== "NotInScope") skills.push("broker-dealer");
  if (s.ind_ia_scope && s.ind_ia_scope !== "NotInScope") skills.push("investment adviser");

  const summary =
    yearsExperience !== null
      ? `FINRA-registered since ~${yearsExperience} years — CRD ${s.ind_source_id}`
      : `FINRA-registered — CRD ${s.ind_source_id}`;

  return normalizeCandidate(
    {
      id: `finra:${s.ind_source_id}`,
      name,
      headline: "FINRA-registered representative",
      field: "finance",
      location,
      yearsExperience,
      education: null,
      educationLevel: null,
      skills,
      certifications: ["FINRA Registered"],
      summary,
      sourceUrl: `https://brokercheck.finra.org/individual/summary/${s.ind_source_id}`,
      avatarUrl: null,
      raw: {
        crd: s.ind_source_id,
        industryDays: s.ind_industry_days ?? null,
        currentEmployments: employments,
        bcScope: s.ind_bc_scope ?? null,
        iaScope: s.ind_ia_scope ?? null,
      },
    },
    "finra",
    index
  );
}

export const provider = {
  key: "finra",
  label: "FINRA BrokerCheck (US finance, official)",
  fields: ["finance"],
  traits: {
    // brokercheck.finra.org/individual/summary/<CRD> is unique per CRD.
    sourceUrlIdentifiesPerson: true,
    nameIsHandle: false,
    dataIsLLMExtracted: false,
    entityType: "person",
  },

  async search(jobSpec, _options = {}) {
    try {
      const query = deriveQuery(jobSpec);
      if (!query) return [];

      const params = new URLSearchParams({
        query,
        hl: "true",
        "json.wrf": "",
        wt: "json",
        start: "0",
        rows: String(MAX_CANDIDATES),
      });
      const data = await fetchJson(`${API_BASE}?${params}`);
      const hits = Array.isArray(data?.hits?.hits) ? data.hits.hits : [];

      const wantedLocation = jobSpec?.location || "";
      const filtered = hits.filter((h) =>
        locationMatchesEmployments(wantedLocation, h?._source?.ind_current_employments)
      );

      return filtered.slice(0, MAX_CANDIDATES).map((h, i) => toCandidate(h, i));
    } catch (err) {
      console.warn(`[recruiter-ai] FINRA BrokerCheck provider failed: ${err.message}`);
      return [];
    }
  },
};
