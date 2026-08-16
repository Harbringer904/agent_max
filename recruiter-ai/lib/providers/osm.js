// lib/providers/osm.js
//
// OpenStreetMap provider — a genuinely FREE, no-key, no-card alternative to
// Google Places. Geocodes jobSpec.location via Nominatim (OSM's own free
// geocoder), then queries the free Overpass API for real-world businesses/
// offices near that point, tagged by field.
//
// HONEST LIMITATION (verified by hand before shipping this): OSM's free
// public Overpass instances are shared, rate-limited infrastructure with NO
// uptime guarantee. Even simple queries can time out under load. This
// provider is fully fault-tolerant (returns [] on any failure, never crashes
// search) and is NOT set as any field's default for that reason — it's an
// opt-in "try it, it's free" option, not a reliable primary source. Coverage
// also depends on volunteer OSM tagging, which is thinner for professional
// services than Google's index.
//
// Exports:
//   provider   { key:"osm", label, fields:["*"], search(jobSpec, options) }

import { normalizeCandidate } from "../normalize.js";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
// Two free Overpass mirrors — the second is tried only if the first fails.
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const USER_AGENT = "recruiter-ai (free/hobby project; contact via github.com/Harbringer904/agent_max)";
const GEOCODE_TIMEOUT_MS = 10_000;
const OVERPASS_TIMEOUT_MS = 25_000;
const SEARCH_RADIUS_M = 15_000; // 15km around the geocoded point
const MAX_CANDIDATES = 20;

// Best-effort field -> OSM `office` tag value. OSM's tag vocabulary doesn't
// have a slot for every field (e.g. "sales", "healthcare" aren't office
// categories in OSM) — those fall back to the generic "company" tag, which
// still returns real named businesses, just not narrowly filtered.
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

/** Geocode a free-text location to { lat, lon } via Nominatim. Returns null on failure. */
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

/** Try each Overpass mirror in turn; return the first successful JSON body. */
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
      // try the next mirror
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
    // openstreetmap.org/<type>/<id> is unique per node — not a shared
    // listing page — so a URL match still reliably means "the same record",
    // even though the record is a business rather than a person.
    sourceUrlIdentifiesPerson: true,
    nameIsHandle: false,
    dataIsLLMExtracted: false,
    entityType: "organization",
  },

  async search(jobSpec, _options = {}) {
    try {
      const location = String(jobSpec?.location || "").trim();
      if (!location) return []; // OSM search is location-anchored; no location, no query.

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
