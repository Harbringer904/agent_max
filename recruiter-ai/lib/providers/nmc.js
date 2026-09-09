// KNOWN CAVEAT — TLS: nmc.org.in's certificate chain is missing its
// intermediate CA cert (verified independently: the leaf is a real
// Sectigo-issued cert for *.nmc.org.in; browsers paper over this via cached
// intermediate certs, strict clients like Node's fetch() do not). We use
// Node's `https` module with a dedicated Agent that skips chain verification
// for THIS PROVIDER ONLY — every other request in the app (GitHub, Stack
// Overflow, Google, LLM APIs) keeps full TLS verification. This only ever
// reads public, non-sensitive government data; no credentials cross it.

import https from "https";
import { normalizeCandidate } from "../normalize.js";

const HOST = "www.nmc.org.in";
const BASE_PATH = "/MCIRest/open";
const TIMEOUT_MS = 20_000;
const MAX_CANDIDATES = 20;

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

const SMC_MAP = {
  1: "Andhra Pradesh Medical Council",
  2: "Arunachal Pradesh Medical Council",
  3: "Assam Medical Council",
  28: "Bhopal Medical Council",
  4: "Bihar Medical Council",
  29: "Bombay Medical Council",
  30: "Chandigarh Medical Council",
  5: "Chattisgarh Medical Council",
  6: "Delhi Medical Council",
  7: "Goa Medical Council",
  8: "Gujarat Medical Council",
  9: "Haryana Medical Councils",
  10: "Himachal Pradesh Medical Council",
  45: "Hyderabad Medical Council",
  11: "Jammu & Kashmir Medical Council",
  12: "Jharkhand Medical Council",
  13: "Karnataka Medical Council",
  15: "Madhya Pradesh Medical Council",
  36: "Madras Medical Council",
  35: "Mahakoshal Medical Council",
  16: "Maharashtra Medical Council",
  26: "Manipur Medical Council",
  51: "Meghalaya Medical Council",
  42: "Mizoram Medical Council",
  37: "Mysore Medical Council",
  41: "Nagaland Medical Council",
  17: "Orissa Council of Medical Registration",
  38: "Pondicherry Medical Council",
  18: "Punjab Medical Council",
  19: "Rajasthan Medical Council",
  20: "Sikkim Medical Council",
  21: "Tamil Nadu Medical Council",
  43: "Telangana State Medical Council",
  50: "Travancore Cochin Medical Council, Trivandrum",
  22: "Tripura State Medical Council",
  23: "Uttar Pradesh Medical Council",
  24: "Uttarakhand Medical Council",
  40: "Vidharba Medical Council",
  25: "West Bengal Medical Council",
};

const CITY_TO_SMC_ID = {
  delhi: 6,
  "new delhi": 6,
  mumbai: 16,
  pune: 16,
  nagpur: 16,
  nashik: 16,
  bengaluru: 13,
  bangalore: 13,
  chennai: 21,
  hyderabad: 43,
  secunderabad: 43,
  kolkata: 25,
  ahmedabad: 8,
  surat: 8,
  jaipur: 19,
  lucknow: 23,
  kanpur: 23,
  noida: 23,
  ghaziabad: 23,
  chandigarh: 30,
  bhopal: 15,
  indore: 15,
  patna: 4,
  goa: 7,
};

function resolveSmcId(locationText) {
  const loc = String(locationText || "").toLowerCase().trim();
  if (!loc) return null;
  for (const [city, id] of Object.entries(CITY_TO_SMC_ID)) {
    if (loc.includes(city)) return id;
  }
  for (const [id, name] of Object.entries(SMC_MAP)) {
    const stateName = name.toLowerCase().replace(/ medical council(s)?/, "").trim();
    if (stateName && (loc.includes(stateName) || stateName.includes(loc))) return Number(id);
  }
  return "unknown";
}

function httpsJson(path, { method = "GET", body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        host: HOST,
        path,
        method,
        agent: insecureAgent,
        timeout: TIMEOUT_MS,
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "application/json",
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error(`NMC API ${res.statusCode}`));
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error(`NMC API returned invalid JSON: ${err.message}`));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("NMC API request timed out")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function fetchList(smcId) {
  const qs = new URLSearchParams({
    service: "getPaginatedDoctor",
    smcId: smcId === null ? "" : String(smcId),
    draw: "1",
    start: "0",
    length: String(MAX_CANDIDATES),
  });
  const json = await httpsJson(`${BASE_PATH}/getPaginatedData?${qs}`);
  return Array.isArray(json?.data) ? json.data : [];
}

async function fetchDetail(doctorId, regdNo) {
  try {
    const detail = await httpsJson(`${BASE_PATH}/getDataFromService?service=getDoctorDetailsByIdImrExt`, {
      method: "POST",
      body: { doctorId: String(doctorId), regdNoValue: encodeURIComponent(regdNo) },
    });
    return detail && typeof detail === "object" ? detail : {};
  } catch {
    return {};
  }
}

function extractDoctorId(viewLinkHtml) {
  const m = String(viewLinkHtml || "").match(/openDoctorDetailsnew\('(\d+)'/);
  return m ? m[1] : null;
}

function titleCaseName(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function toCandidate(row, detail, index) {
  const [, regYear, regNo, councilName, rawName] = row;
  const name = titleCaseName(rawName);
  const degree = detail.doctorDegree || null;
  const university = detail.university || null;
  const yearOfPassing = Number(detail.yearOfPassing) || Number(regYear) || null;
  const yearsExperience = yearOfPassing ? Math.max(0, new Date().getFullYear() - yearOfPassing) : null;
  const address = detail.address || detail.officeAddress || detail.homeAddress || null;

  return normalizeCandidate(
    {
      id: `nmc:${regNo || index}`,
      name,
      headline: `NMC Registered Doctor${degree ? ` — ${degree}` : ""}`,
      field: "healthcare",
      location: address || councilName || null,
      yearsExperience,
      education: degree,
      educationLevel: degree ? 3 : null,
      skills: degree ? [degree] : [],
      certifications: ["NMC Registered"],
      summary: [degree, university && `(${university})`, `Reg. ${regNo}, ${councilName}`]
        .filter(Boolean)
        .join(" ") || null,
      sourceUrl: "https://www.nmc.org.in/information-desk/indian-medical-register/",
      avatarUrl: null,
      raw: { registrationNo: regNo, registrationYear: regYear, council: councilName, ...detail },
    },
    "nmc",
    index
  );
}

export const provider = {
  key: "nmc",
  label: "NMC Registered Doctors (official data)",
  fields: ["healthcare"],
  traits: {
    sourceUrlIdentifiesPerson: false,
    nameIsHandle: false,
    dataIsLLMExtracted: false,
    entityType: "person",
  },

  async search(jobSpec, _options = {}) {
    try {
      const smcId = resolveSmcId(jobSpec?.location);
      if (smcId === "unknown") return [];

      const rows = await fetchList(smcId);
      if (rows.length === 0) return [];

      const details = await Promise.all(
        rows.map((row) => {
          const doctorId = extractDoctorId(row[6]);
          return doctorId ? fetchDetail(doctorId, row[2]) : Promise.resolve({});
        })
      );

      return rows.map((row, i) => toCandidate(row, details[i] || {}, i));
    } catch (err) {
      console.warn(`[recruiter-ai] NMC provider failed: ${err.message}`);
      return [];
    }
  },
};
