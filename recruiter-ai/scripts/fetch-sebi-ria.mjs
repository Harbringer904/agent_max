// scripts/fetch-sebi-ria.mjs
//
// One-off data-acquisition script (NOT part of the running app). Downloads the
// full public SEBI Registered Investment Adviser directory from sebi.gov.in's
// own search UI (the same read-only, no-login, no-CAPTCHA pages a human
// browses) and writes a snapshot to data/registries/sebi_ria.json.
//
// This is SEBI's own investor-protection transparency tool — the page states
// "Registered intermediaries as on date <today>" and is meant to be browsed
// publicly. We are not bypassing any login/CAPTCHA; we replicate the exact
// AJAX pagination call the site's own "Show All Records" button makes.
//
// Run manually: node scripts/fetch-sebi-ria.mjs
// Re-run periodically to refresh the snapshot; the app never calls SEBI live.

import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, "..", "data", "registries", "sebi_ria.json");

const BASE = "https://www.sebi.gov.in";
const SEARCH_PAGE = `${BASE}/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=13`;
const AJAX_URL = `${BASE}/sebiweb/ajax/other/getintmfpiinfo.jsp`;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

function decodeEntities(str) {
  if (!str) return "";
  return String(str)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// The AJAX partial response uses single-quoted HTML attributes (the initial
// full-page load uses double quotes) — match single quotes here.
function extractField(chunk, label) {
  const re = new RegExp(
    `<span>\\s*${label}\\s*</span></div><div class='value[^']*'><span>([\\s\\S]*?)</span></div>`
  );
  const m = chunk.match(re);
  return m ? decodeEntities(m[1]) : "";
}

/** Derive a "City, State" location string from a SEBI address block. */
function deriveLocation(address) {
  if (!address) return "";
  // Addresses end "..., CITY, STATE, PINCODE" — take the last 3 comma segments.
  const parts = address.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return address;
  const pin = /^\d{5,6}$/.test(parts[parts.length - 1]) ? parts.slice(0, -1) : parts;
  const state = pin[pin.length - 1] || "";
  const city = pin[pin.length - 2] || "";
  return [city, state].filter(Boolean).join(", ");
}

/** Whole years since a "Mon D, YYYY - ..." validity start date. */
function yearsSinceValidity(validity) {
  const m = validity && validity.match(/([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})/);
  if (!m) return null;
  const start = new Date(m[1]);
  if (Number.isNaN(start.getTime())) return null;
  const years = (Date.now() - start.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  return Math.max(0, Math.floor(years));
}

function parseRecords(html) {
  // Record boundary is <div class='card-table-left'> or <div class='card-table-left right'>.
  const chunks = html.split(/<div class='card-table-left[^']*'>/).slice(1);
  const records = [];
  for (const chunk of chunks) {
    const name = extractField(chunk, "Name");
    if (!name) continue;
    const regNo = extractField(chunk, "Registration No\\.");
    const email = extractField(chunk, "E-mail");
    const telephone = extractField(chunk, "Telephone");
    const address = extractField(chunk, "Address");
    const contactPerson = extractField(chunk, "Contact Person");
    const correspondenceAddress = extractField(chunk, "Correspondence Address");
    const validity = extractField(chunk, "Validity");
    records.push({
      name,
      registrationNo: regNo,
      email,
      telephone,
      address,
      contactPerson,
      correspondenceAddress,
      validity,
      location: deriveLocation(correspondenceAddress || address),
      yearsRegistered: yearsSinceValidity(validity),
    });
  }
  return records;
}

async function fetchInitialSession() {
  const res = await fetch(SEARCH_PAGE, { headers: { "User-Agent": UA } });
  const html = await res.text();
  const setCookie = res.headers.get("set-cookie") || "";
  const jsessionMatch =
    setCookie.match(/JSESSIONID=([^;]+)/i) || html.match(/jsessionid=([A-F0-9]+)/i);
  const jsessionid = jsessionMatch ? jsessionMatch[1] : null;
  const totalMatch = html.match(/of\s+([\d,]+)\s+records/);
  const total = totalMatch ? Number(totalMatch[1].replace(/,/g, "")) : null;
  return { jsessionid, total };
}

async function fetchPage(jsessionid, pageIndex) {
  const body = new URLSearchParams({
    nextValue: String(pageIndex),
    next: "n",
    intmId: "13",
    contPer: "",
    name: "",
    regNo: "",
    email: "",
    location: "",
    exchange: "",
    affiliate: "",
    alp: "",
    doDirect: String(pageIndex),
    intmIds: "",
  });
  const res = await fetch(AJAX_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": UA,
      Referer: SEARCH_PAGE,
      "X-Requested-With": "XMLHttpRequest",
      Cookie: jsessionid ? `JSESSIONID=${jsessionid}` : "",
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Page ${pageIndex} failed: HTTP ${res.status}`);
  return res.text();
}

async function main() {
  console.log("Fetching SEBI RIA session...");
  const { jsessionid, total } = await fetchInitialSession();
  if (!jsessionid) throw new Error("Could not establish a session (no JSESSIONID found).");
  console.log(`Session OK. SEBI reports ${total ?? "unknown"} total records.`);

  const totalPages = Math.ceil((total || 1042) / 25);
  const all = [];
  for (let page = 0; page < totalPages; page++) {
    const html = await fetchPage(jsessionid, page);
    const records = parseRecords(html);
    if (records.length === 0 && page > 0) {
      console.warn(`Page ${page}: 0 records parsed, stopping early.`);
      break;
    }
    all.push(...records);
    console.log(`Page ${page + 1}/${totalPages}: +${records.length} (total ${all.length})`);
    // Be a polite, low-rate client — this is a public site, not an API meant for bulk hammering.
    await new Promise((r) => setTimeout(r, 400));
  }

  mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  writeFileSync(
    OUT_PATH,
    JSON.stringify(
      {
        source: "SEBI (Securities and Exchange Board of India) — Registered Investment Advisers",
        sourceUrl: SEARCH_PAGE,
        fetchedAt: new Date().toISOString(),
        count: all.length,
        records: all,
      },
      null,
      2
    )
  );
  console.log(`\nWrote ${all.length} records to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error("Fetch failed:", err);
  process.exit(1);
});
