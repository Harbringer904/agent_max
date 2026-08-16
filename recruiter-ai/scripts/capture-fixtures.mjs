// scripts/capture-fixtures.mjs
//
// Captures REAL provider responses into test/fixtures/<providerKey>.json.
//
// WHY THIS EXISTS (docs/DATA_QUALITY_PLAN.md P1):
// All three shipped bugs happened because fixtures were IMAGINED by whoever
// wrote the test — and an imagined fixture encodes the author's assumptions,
// which is exactly what was wrong (unique sourceUrls that don't exist in
// reality, "candidates" nobody checked were actual people). This script
// replaces imagination with a live capture: it queries every provider with
// the same realistic probe scripts/doctor.mjs uses and writes down exactly
// what came back, unmodified. test/providerContract.test.js then asserts
// invariants against these captures OFFLINE, so CI needs no keys/network but
// still defends against real-world shapes.
//
// This is public data (registry listings, public profiles, published
// research) — nothing here is redacted.
//
// A provider that returns 0 candidates (rate-limited, no key configured) is
// SKIPPED rather than written as an empty fixture: an empty fixture would
// make providerContract.test.js vacuously pass for that provider forever,
// silently losing coverage. Re-run this script when quota/keys are available
// to pick it up.
//
// Run: npm run capture-fixtures

import "dotenv/config";
import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { listProviders, getProvider } from "../lib/providers/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "..", "test", "fixtures");

// Needs caller-supplied data (a CSV/JSON upload), not a live query — same
// exclusion doctor.mjs makes, for the same reason.
const SKIP = new Set(["upload"]);

/** A realistic probe per provider — mirrors scripts/doctor.mjs probeFor()
 * exactly, so the capture reflects the same real-world query shape the
 * doctor sweep already validated. Kept as a separate copy rather than a
 * shared import because doctor.mjs performs its sweep as import-time
 * top-level code, so importing it here would trigger a second live run. */
function probeFor(key) {
  const skills = (arr) => ({ key: "skills", label: "Skills", weight: 3, requiredSkills: arr });
  const loc = (l) => ({ key: "location", label: "Location", weight: 2, desiredLocation: l });
  switch (key) {
    case "sebi_ria":
    case "finra":
      return { field: "finance", title: "Financial Adviser", location: key === "finra" ? "New York" : "Delhi", criteria: [loc(key === "finra" ? "New York" : "Delhi")] };
    case "nmc":
      return { field: "healthcare", title: "Physician", location: "Delhi", criteria: [loc("Delhi")] };
    case "npi":
      return { field: "healthcare", title: "Registered Nurse", location: "New York", criteria: [loc("New York")] };
    case "github":
    case "stackoverflow":
    case "devto":
      return { field: "software", title: "Developer", location: null, criteria: [skills(["javascript"])] };
    case "huggingface":
      return { field: "software", title: "ML Engineer", location: null, criteria: [skills(["llama"])] };
    case "hn_hiring":
      return { field: "software", title: "Developer", location: null, criteria: [skills(["python"])] };
    case "orcid":
      return { field: "research", title: "Researcher", location: "Harvard", criteria: [skills(["biology"])] };
    case "openalex":
      return { field: "research", title: "Researcher", location: null, criteria: [skills(["machine learning"])] };
    case "google_places":
    case "osm":
      return { field: "finance", title: "Financial Adviser", location: "Mumbai", criteria: [loc("Mumbai")] };
    case "open_web":
      return { field: "design", title: "UX Designer", location: "Bangalore", criteria: [skills(["figma"])] };
    case "sample":
      return { field: "healthcare", title: "Registered Nurse", location: null, criteria: [skills(["patient care"])] };
    default:
      return { field: "software", title: "Engineer", location: null, criteria: [skills(["javascript"])] };
  }
}

mkdirSync(FIXTURES_DIR, { recursive: true });

const providers = listProviders().filter((p) => !SKIP.has(p.key));
const written = [];
const skipped = [];

console.log(`\nagent_max capture-fixtures — probing ${providers.length} providers with real calls\n`);

for (const { key } of providers) {
  const jobSpec = probeFor(key);
  let cands = [];
  let err = null;
  try {
    cands = await getProvider(key).search(jobSpec, {});
  } catch (e) {
    err = e.message;
  }

  if (err) {
    skipped.push(`${key} (error: ${err})`);
    console.log(`  SKIP ${key}: ${err}`);
    continue;
  }
  if (!cands.length) {
    skipped.push(`${key} (0 candidates — rate-limited or key-less)`);
    console.log(`  SKIP ${key}: 0 candidates`);
    continue;
  }

  const fixturePath = path.join(FIXTURES_DIR, `${key}.json`);
  writeFileSync(fixturePath, JSON.stringify(cands, null, 2) + "\n");
  written.push(`${key} (${cands.length})`);
  console.log(`  WROTE ${key}: ${cands.length} candidates -> test/fixtures/${key}.json`);
}

console.log(`\n${written.length} fixture(s) written, ${skipped.length} provider(s) skipped.`);
if (skipped.length) {
  console.log("\nSkipped (no fixture written — re-run when quota/keys are available):");
  for (const s of skipped) console.log(`  - ${s}`);
}
console.log();
