// lib/providers/googlePlaces.js
//
// Google Places provider — searches Google's live business index (Places API,
// "New" Text Search) for real local professionals/firms matching the job
// title + location, and maps them to unified Candidates. Works for ANY
// field (finance, sales, design, ...), unlike the dev-only github/stackoverflow
// providers, because it searches real-world businesses rather than a coder
// platform.
//
// Requires a free-tier Google Cloud API key (GOOGLE_PLACES_API_KEY). Google
// requires a billing account on file to issue the key, but Places Text Search
// carries a monthly free-usage credit that ordinary use stays well within.
// Without a key, this provider returns [] — it never crashes the app.
//
// Exports:
//   provider          { key:"google_places", label:"Google Places", fields:["*"], search(jobSpec, options) }
//   hasGooglePlacesKey()  boolean — whether GOOGLE_PLACES_API_KEY is configured

import dotenv from "dotenv";
import { normalizeCandidate } from "../normalize.js";

dotenv.config();

const API_KEY = process.env.GOOGLE_PLACES_API_KEY?.trim() || null;
const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const TIMEOUT_MS = 15_000;
const MAX_CANDIDATES = 20; // Places Text Search returns up to 20 results per page.
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

/**
 * Build the free-text search query from the jobSpec: "<title> in <location>".
 * Falls back to a location criterion's desiredLocation if jobSpec.location is
 * unset, and to jobSpec.field if there's no title. Returns null if there is
 * no usable title at all (Places needs a real category to search).
 */
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
      yearsExperience: null, // Google Places doesn't expose this
      education: null,
      educationLevel: null,
      skills: types, // Google's coarse business-category tags — weak signal, but real
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
    // place.googleMapsUri is unique per place — not a shared listing page —
    // so a URL match still reliably means "the same record", even though
    // the record is a business rather than a person.
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
