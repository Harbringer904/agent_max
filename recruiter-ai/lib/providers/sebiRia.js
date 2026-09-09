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

    if (wantedLocation && matches.length === 0) return [];

    return matches.slice(0, MAX_CANDIDATES).map((r, i) => toCandidate(r, i));
  },
};
