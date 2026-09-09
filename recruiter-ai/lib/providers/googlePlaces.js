import dotenv from "dotenv";
import { normalizeCandidate } from "../normalize.js";

dotenv.config();

const API_KEY = process.env.GOOGLE_PLACES_API_KEY?.trim() || null;
const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const TIMEOUT_MS = 15_000;
const MAX_CANDIDATES = 20;
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.googleMapsUri",
  "places.rating",
  "places.userRatingCount",
  "places.types",
].join(",");

export function hasGooglePlacesKey() {
  return Boolean(API_KEY);
}

function buildQuery(jobSpec) {
  const title = String(jobSpec?.title || jobSpec?.field || "").trim();
  if (!title) return null;

  let location = String(jobSpec?.location || "").trim();
  if (!location) {
    const locationCriterion = (jobSpec?.criteria || []).find(
      (c) => c.key === "location" && c.desiredLocation
    );
    location = String(locationCriterion?.desiredLocation || "").trim();
  }

  return location ? `${title} in ${location}` : title;
}

async function fetchJson(url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": API_KEY,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Google Places API ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function toCandidate(place, jobSpec, index) {
  const name = place.displayName?.text || "";
  const rating = typeof place.rating === "number" ? place.rating : null;
  const reviewCount = typeof place.userRatingCount === "number" ? place.userRatingCount : null;
  const types = Array.isArray(place.types) ? place.types : [];

  return normalizeCandidate(
    {
      id: `google_places:${place.id}`,
      name,
      headline:
        rating !== null
          ? `${rating}★ (${reviewCount ?? 0} review${reviewCount === 1 ? "" : "s"})`
          : jobSpec?.title || "Local business",
      field: jobSpec?.field || "",
      location: place.formattedAddress ?? null,
      yearsExperience: null,
      education: null,
      educationLevel: null,
      skills: types,
      certifications: [],
      summary: [jobSpec?.title, place.formattedAddress].filter(Boolean).join(" — ") || null,
      sourceUrl: place.googleMapsUri ?? null,
      avatarUrl: null,
      raw: {
        placeId: place.id,
        phone: place.internationalPhoneNumber ?? null,
        website: place.websiteUri ?? null,
        rating,
        userRatingCount: reviewCount,
        types,
      },
    },
    "google_places",
    index
  );
}

export const provider = {
  key: "google_places",
  label: "Google Places (real local businesses)",
  fields: ["*"],
  traits: {
    sourceUrlIdentifiesPerson: true,
    nameIsHandle: false,
    dataIsLLMExtracted: false,
    entityType: "organization",
  },

  async search(jobSpec, _options = {}) {
    if (!API_KEY) return [];
    try {
      const query = buildQuery(jobSpec);
      if (!query) return [];

      const data = await fetchJson(SEARCH_URL, { textQuery: query, pageSize: MAX_CANDIDATES });
      const places = Array.isArray(data?.places) ? data.places : [];

      return places.slice(0, MAX_CANDIDATES).map((place, i) => toCandidate(place, jobSpec, i));
    } catch (err) {
      console.warn(`[recruiter-ai] Google Places provider failed: ${err.message}`);
      return [];
    }
  },
};
