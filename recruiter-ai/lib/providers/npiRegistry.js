import { normalizeCandidate } from "../normalize.js";

const API_BASE = "https://npiregistry.cms.hhs.gov/api/";
const TIMEOUT_MS = 15_000;
const MAX_CANDIDATES = 20;

const US_STATE_MAP = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO",
  montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH",
  oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
  "district of columbia": "DC",
  "new york city": "NY", nyc: "NY", brooklyn: "NY", manhattan: "NY", "los angeles": "CA",
  la: "CA", "san francisco": "CA", "san diego": "CA", "san jose": "CA", chicago: "IL",
  houston: "TX", austin: "TX", dallas: "TX", "san antonio": "TX", phoenix: "AZ",
  philadelphia: "PA", boston: "MA", seattle: "WA", denver: "CO", atlanta: "GA",
  miami: "FL", orlando: "FL", tampa: "FL",
};

const VALID_STATE_CODES = new Set(Object.values(US_STATE_MAP));

function mapLocationToState(location) {
  const raw = String(location || "").trim();
  if (!raw) return null;

  const tokens = raw.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
  for (const tok of tokens) {
    const code = tok.toUpperCase();
    if (VALID_STATE_CODES.has(code)) return code;
  }

  const lower = raw.toLowerCase();
  const keys = Object.keys(US_STATE_MAP).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (lower === key || lower.includes(key)) return US_STATE_MAP[key];
  }
  return null;
}

const TITLE_TO_TAXONOMY = [
  [/\bnurse\b/, "Registered Nurse"],
  [/\bphysician\b|\bdoctor\b/, "Family Medicine"],
  [/\bdentist\b/, "Dentist"],
  [/\bpharmac/, "Pharmacist"],
  [/\btherap/, "Physical Therapist"],
];

function deriveTaxonomyDescription(jobSpec) {
  const skillsCriterion = (jobSpec?.criteria || []).find((c) => c.key === "skills");
  const requiredSkills = skillsCriterion?.requiredSkills || [];
  const text = `${jobSpec?.title || ""} ${requiredSkills.join(" ")}`.toLowerCase();
  for (const [pattern, taxonomy] of TITLE_TO_TAXONOMY) {
    if (pattern.test(text)) return taxonomy;
  }
  return null;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`NPI Registry API ${res.status}`);
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

function yearsSinceEnumeration(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  const years = (Date.now() - d.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  return Math.max(0, Math.floor(years));
}

function toCandidate(result, index) {
  const basic = result.basic || {};
  const addresses = Array.isArray(result.addresses) ? result.addresses : [];
  const taxonomies = Array.isArray(result.taxonomies) ? result.taxonomies : [];

  const locationAddr = addresses.find((a) => a.address_purpose === "LOCATION") || addresses[0] || {};
  const primaryTaxonomy = taxonomies.find((t) => t.primary) || taxonomies[0] || {};

  const name = titleCase(`${basic.first_name || ""} ${basic.last_name || ""}`);
  const credential = basic.credential || null;
  const headline = `${primaryTaxonomy.desc || "Healthcare Provider"}${credential ? ` — ${credential}` : ""}`;
  const location = locationAddr.city ? `${locationAddr.city}, ${locationAddr.state || ""}`.replace(/, $/, "") : null;

  const certifications = ["NPI Registered", ...(credential ? [credential] : [])];
  const skills = [...new Set(taxonomies.map((t) => t.desc).filter(Boolean))];

  return normalizeCandidate(
    {
      id: `npi:${result.number}`,
      name,
      headline,
      field: "healthcare",
      location,
      yearsExperience: yearsSinceEnumeration(basic.enumeration_date),
      education: null,
      educationLevel: null,
      skills,
      certifications,
      summary: `${primaryTaxonomy.desc || "Healthcare Provider"} in ${location || "an unspecified location"} — NPI ${result.number}`,
      sourceUrl: `https://npiregistry.cms.hhs.gov/provider-view/${result.number}`,
      avatarUrl: null,
      raw: {
        npi: result.number,
        taxonomies,
        phone: locationAddr.telephone_number || null,
        licenseState: primaryTaxonomy.state || null,
      },
    },
    "npi",
    index
  );
}

export const provider = {
  key: "npi",
  label: "NPI Registry (US healthcare, official)",
  fields: ["healthcare"],
  traits: {
    sourceUrlIdentifiesPerson: true,
    nameIsHandle: false,
    dataIsLLMExtracted: false,
    entityType: "person",
  },

  async search(jobSpec, _options = {}) {
    try {
      const state = mapLocationToState(jobSpec?.location);
      if (!state) return [];

      const params = new URLSearchParams({
        version: "2.1",
        enumeration_type: "NPI-1",
        state,
        limit: String(MAX_CANDIDATES),
      });
      const taxonomyDescription = deriveTaxonomyDescription(jobSpec);
      if (taxonomyDescription) params.set("taxonomy_description", taxonomyDescription);

      const data = await fetchJson(`${API_BASE}?${params}`);
      const results = Array.isArray(data?.results) ? data.results : [];

      return results.slice(0, MAX_CANDIDATES).map((r, i) => toCandidate(r, i));
    } catch (err) {
      console.warn(`[recruiter-ai] NPI Registry provider failed: ${err.message}`);
      return [];
    }
  },
};
