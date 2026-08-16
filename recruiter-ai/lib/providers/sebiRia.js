// lib/providers/sebiRia.js
//
// SEBI Registered Investment Adviser provider — serves a bundled snapshot of
// the REAL, official SEBI RIA registry (data/registries/sebi_ria.json, 1042
// records as fetched by scripts/fetch-sebi-ria.mjs from sebi.gov.in's own
// public, no-login investor-verification directory).
//
// This is a snapshot, not a live query: the app never calls SEBI on a search
// (that would be disrespectful of a public government service). Re-run the
// fetch script periodically to refresh data/registries/sebi_ria.json.
//
// Exports:
//   provider   { key:"sebi_ria", label, fields:["finance"], search(jobSpec, options) }

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { normalizeCandidate } from "../normalize.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "..", "data", "registries", "sebi_ria.json");

const MAX_CANDIDATES = 25;

let cachedRecords = null;
let cachedMeta = null;

function loadRecords() {
  if (cachedRecords !== null) return cachedRecords;
  try {
    const raw = JSON.parse(readFileSync(DATA_PATH, "utf8"));
    const rows = Array.isArray(raw.records) ? raw.records : [];
    // SEBI's own paginated listing occasionally repeats a row across a page
    // boundary (~0.3% of records) — dedupe by registration number.
    const seen = new Set();
    cachedRecords = rows.filter((r) => {
      const key = r.registrationNo || r.name;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    cachedMeta = { source: raw.source, sourceUrl: raw.sourceUrl, fetchedAt: raw.fetchedAt };
  } catch {
    cachedRecords = [];
    cachedMeta = null;
  }
  return cachedRecords;
}

/** Case-insensitive, either-direction substring match — same rule as the
 * scoring engine's own location criterion, so pre-filtering here agrees with
 * how results will later be scored. */
function locationMatches(wanted, have) {
  const w = String(wanted || "").toLowerCase().trim();
  const h = String(have || "").toLowerCase().trim();
  if (!w || !h) return false;
  return h.includes(w) || w.includes(h);
}

function toCandidate(record, index) {
  const certs = ["SEBI RIA"];
  const summaryParts = [
    `SEBI-registered Investment Adviser`,
    record.registrationNo ? `(Reg. No. ${record.registrationNo})` : null,
    record.validity ? `— registered ${record.validity}` : null,
  ].filter(Boolean);

  return normalizeCandidate(
    {
      id: `sebi_ria:${record.registrationNo || index}`,
      name: record.name,
      headline: `SEBI Registered Investment Adviser — ${record.registrationNo || "unregistered no."}`,
      field: "finance",
      location: record.location || null,
      yearsExperience: record.yearsRegistered ?? null,
      education: null,
      educationLevel: null,
      skills: ["investment advisory", "financial planning", "wealth management"],
      certifications: certs,
      summary: summaryParts.join(" ") || null,
      sourceUrl: cachedMeta?.sourceUrl || null,
      avatarUrl: null,
      raw: {
        registrationNo: record.registrationNo,
        email: record.email,
        telephone: record.telephone,
        address: record.address,
        contactPerson: record.contactPerson,
        correspondenceAddress: record.correspondenceAddress,
        validity: record.validity,
      },
    },
    "sebi_ria",
    index
  );
}

export const provider = {
  key: "sebi_ria",
  label: "SEBI Registered Investment Advisers (official data)",
  fields: ["finance"],
  traits: {
    // Every record gets the SAME sourceUrl (cachedMeta.sourceUrl — the
    // registry's own listing page, not a per-adviser permalink). Verified
    // live: 25 distinct advisers sharing 1 URL. Must never drive URL-merge.
    sourceUrlIdentifiesPerson: false,
    nameIsHandle: false,
    dataIsLLMExtracted: false,
    entityType: "person",
  },

  async search(jobSpec, _options = {}) {
    const records = loadRecords();
    if (records.length === 0) return [];

    const wantedLocation = String(jobSpec?.location || "").trim();
    let matches = wantedLocation
      ? records.filter((r) => locationMatches(wantedLocation, r.location))
      : records;

    // No location match found for a specific request: better to return
    // nothing (so the recruiter knows to broaden) than to silently show
    // people from the wrong city.
    if (wantedLocation && matches.length === 0) return [];

    return matches.slice(0, MAX_CANDIDATES).map((r, i) => toCandidate(r, i));
  },
};
