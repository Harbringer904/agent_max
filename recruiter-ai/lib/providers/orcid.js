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
  traits: {
    sourceUrlIdentifiesPerson: true,
    nameIsHandle: false,
    dataIsLLMExtracted: false,
    entityType: "person",
  },

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
