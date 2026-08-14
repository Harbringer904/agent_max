// lib/providers/orcid.js
//
// ORCID provider — searches the free, keyless public ORCID API
// (expanded-search) for researchers matching the jobSpec's required skills
// and (optionally) current institution affiliation, and maps them to
// unified Candidates.
//
// Exports:
//   provider   { key:"orcid", label:"ORCID (researchers)", fields:["research"], search(jobSpec, options) }

import { normalizeCandidate } from "../normalize.js";

const API_BASE = "https://pub.orcid.org/v3.0/expanded-search/";
const TIMEOUT_MS = 15_000;
const MAX_CANDIDATES = 20;
const ROWS = 20;

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // ORCID returns XML by default — Accept: application/json is required.
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`ORCID API ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the ORCID Solr/Lucene query string.
 *
 * Location: verified both `affiliation-org-name:"<X>"` (broader — matches
 * any past or present affiliation) and `current-institution-affiliation-name:"<X>"`
 * (narrower — only the researcher's CURRENT institution) work. We use the
 * latter: it's more semantically correct for a recruiter search (you want
 * who works there NOW, not who passed through decades ago), and it's the
 * form verified in this task's spec (q=`biology AND
 * current-institution-affiliation-name:Harvard` -> num-found 4717).
 */
function buildQuery(jobSpec) {
  const skillsCriterion = (jobSpec?.criteria || []).find((c) => c.key === "skills");
  const requiredSkills = skillsCriterion?.requiredSkills || [];

  let freeText = requiredSkills.filter(Boolean).join(" AND ");
  if (!freeText) freeText = String(jobSpec?.title || "").trim();
  if (!freeText) return null;

  const location = String(jobSpec?.location || "").trim();
  if (location) {
    freeText += ` AND current-institution-affiliation-name:"${location}"`;
  }
  return freeText;
}

function toCandidate(result, requiredSkills, index) {
  const institutions = Array.isArray(result["institution-name"])
    ? result["institution-name"].filter(Boolean)
    : [];
  const emails = Array.isArray(result.email) ? result.email.filter(Boolean) : [];
  const name =
    result["credit-name"] ||
    [result["given-names"], result["family-names"]].filter(Boolean).join(" ").trim();

  // Honest skill matching: only include required skills that literally
  // appear in text we actually have (institution names) — never invent.
  const haystack = institutions.join(" ").toLowerCase();
  const matchedSkills = requiredSkills.filter(
    (skill) => skill && haystack.includes(String(skill).toLowerCase())
  );

  return normalizeCandidate(
    {
      id: `orcid:${result["orcid-id"]}`,
      name,
      headline: institutions.length
        ? `Researcher — ${institutions[0]}`
        : "Researcher",
      field: "research",
      // ORCID gives institution affiliation, not a city/region — do not fake one.
      location: null,
      yearsExperience: null,
      education: null,
      educationLevel: null,
      skills: matchedSkills,
      certifications: [],
      summary: institutions.length
        ? `ORCID researcher affiliated with ${institutions.join(", ")}`
        : "ORCID researcher",
      sourceUrl: result["orcid-id"] ? `https://orcid.org/${result["orcid-id"]}` : null,
      avatarUrl: null,
      raw: {
        orcidId: result["orcid-id"],
        institutions,
        emails,
      },
    },
    "orcid",
    index
  );
}

export const provider = {
  key: "orcid",
  label: "ORCID (researchers)",
  fields: ["research"],

  async search(jobSpec, _options = {}) {
    try {
      const query = buildQuery(jobSpec);
      if (!query) return [];

      const skillsCriterion = (jobSpec?.criteria || []).find((c) => c.key === "skills");
      const requiredSkills = skillsCriterion?.requiredSkills || [];

      const url = `${API_BASE}?q=${encodeURIComponent(query)}&rows=${ROWS}`;
      const data = await fetchJson(url);
      const results = Array.isArray(data?.["expanded-result"]) ? data["expanded-result"] : [];

      return results
        .slice(0, MAX_CANDIDATES)
        .map((result, i) => toCandidate(result, requiredSkills, i));
    } catch (err) {
      console.warn(`[recruiter-ai] ORCID provider failed: ${err.message}`);
      return [];
    }
  },
};
