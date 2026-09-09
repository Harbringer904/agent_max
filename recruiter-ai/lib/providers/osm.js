import { normalizeCandidate } from "../normalize.js";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const USER_AGENT = "recruiter-ai (free/hobby project; contact via github.com/Harbringer904/agent_max)";
const GEOCODE_TIMEOUT_MS = 10_000;
const OVERPASS_TIMEOUT_MS = 25_000;
const SEARCH_RADIUS_M = 15_000;
const MAX_CANDIDATES = 20;

const FIELD_TO_OFFICE_TAG = {
  finance: "financial",
  software: "it",
  marketing: "advertising_agency",
  design: "architect",
  operations: "company",
  sales: "company",
  healthcare: "company",
};

function officeTagFor(jobSpec) {
  const field = String(jobSpec?.field || "").toLowerCase().trim();
  return FIELD_TO_OFFICE_TAG[field] || "company";
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function geocode(location) {
  if (!location) return null;
  const url = `${NOMINATIM_URL}?q=${encodeURIComponent(location)}&format=json&limit=1`;
  const res = await fetchWithTimeout(url, { headers: { "User-Agent": USER_AGENT } }, GEOCODE_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const data = await res.json();
  const hit = Array.isArray(data) ? data[0] : null;
  if (!hit) return null;
  return { lat: Number(hit.lat), lon: Number(hit.lon) };
}

function buildQuery(tag, lat, lon) {
  return `[out:json][timeout:20];node["office"="${tag}"](around:${SEARCH_RADIUS_M},${lat},${lon});out tags 40;`;
}

async function queryOverpass(query) {
  let lastErr;
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetchWithTimeout(
        url,
        { method: "POST", headers: { "Content-Type": "text/plain" }, body: query },
        OVERPASS_TIMEOUT_MS
      );
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("All Overpass mirrors failed");
}

function toCandidate(element, jobSpec, tag, index) {
  const tags = element.tags || {};
  const name = tags.name || "";
  const addressParts = [tags["addr:housenumber"], tags["addr:street"], tags["addr:city"]]
    .filter(Boolean)
    .join(" ");

  return normalizeCandidate(
    {
      id: `osm:${element.type}/${element.id}`,
      name,
      headline: tags.office ? `${tags.office.replace(/_/g, " ")} office` : jobSpec?.title || "Local business",
      field: jobSpec?.field || "",
      location: addressParts || tags["addr:city"] || null,
      yearsExperience: null,
      education: null,
      educationLevel: null,
      skills: [tag],
      certifications: [],
      summary: [tags.description, addressParts].filter(Boolean).join(" — ") || null,
      sourceUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`,
      avatarUrl: null,
      raw: { osmType: element.type, osmId: element.id, tags },
    },
    "osm",
    index
  );
}

export const provider = {
  key: "osm",
  label: "OpenStreetMap (free, no key — coverage varies)",
  fields: ["*"],
  traits: {
    sourceUrlIdentifiesPerson: true,
    nameIsHandle: false,
    dataIsLLMExtracted: false,
    entityType: "organization",
  },

  async search(jobSpec, _options = {}) {
    try {
      const location = String(jobSpec?.location || "").trim();
      if (!location) return [];

      const point = await geocode(location);
      if (!point) return [];

      const tag = officeTagFor(jobSpec);
      const data = await queryOverpass(buildQuery(tag, point.lat, point.lon));
      const elements = Array.isArray(data?.elements) ? data.elements : [];
      const named = elements.filter((e) => e.tags && e.tags.name);

      return named.slice(0, MAX_CANDIDATES).map((el, i) => toCandidate(el, jobSpec, tag, i));
    } catch (err) {
      console.warn(`[recruiter-ai] OpenStreetMap provider failed: ${err.message}`);
      return [];
    }
  },
};
