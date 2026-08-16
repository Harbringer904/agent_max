// scripts/doctor.mjs
//
// Reality check for every registered provider. Run: `npm run doctor`
//
// WHY THIS EXISTS (docs/DATA_QUALITY_PLAN.md):
// Three real production bugs shipped past a green test suite because every test
// validated LOGIC AGAINST FABRICATED INPUTS while nothing validated BEHAVIOR
// AGAINST REAL PROVIDER OUTPUT:
//   1. sebi_ria/nmc return the SAME sourceUrl for every record (registry listing
//      page, no per-person permalink) -> dedupe collapsed 25 distinct advisers
//      into 1. Fixtures all had unique URLs, so tests never saw it.
//   2. openalex returned 20/20 non-people (conferences, institutes, datasets).
//      Nothing asserted "a candidate is a person".
//   3. open_web attached invented/misattributed names to pages.
// Each was caught by a human running one real query and reading the output.
// This script automates exactly that sweep.
//
// It makes REAL network calls. It is intentionally NOT part of `npm test`
// (CI must not depend on third-party uptime, keys, or quota).

import "dotenv/config";
import { listProviders, getProvider } from "../lib/providers/index.js";
import { traitsFor } from "../lib/providers/traits.js";
import { looksLikeOrganization } from "../lib/personCheck.js";

const SKIP = new Set(["upload"]); // needs caller-supplied data; covered by unit tests

/** A realistic probe per provider — a generic jobSpec finds nothing useful. */
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

// Mirrors lib/agent/dedupe.js normalizeUrl: the query string is identity-bearing
// (hn_hiring uses ?id=<commentId>) so only noise params are dropped.
const NOISE = /^(utm_|fbclid$|gclid$|ref$|referrer$|source$|tab$|sort$|order$|page$|view$|filter$|lang$|locale$|hl$)/i;
function normUrl(u) {
  if (!u) return "";
  let s = String(u).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("#")[0];
  const q = s.indexOf("?");
  let path = (q >= 0 ? s.slice(0, q) : s).replace(/\/+$/, "");
  if (q < 0) return path;
  const kept = s.slice(q + 1).split("&").filter(kv => kv && !NOISE.test(kv.split("=")[0])).sort();
  return kept.length ? path + "?" + kept.join("&") : path;
}

function pct(n, d) {
  return d === 0 ? "  -  " : String(Math.round((n / d) * 100)).padStart(3) + "%";
}

/** Shape invariants every provider must satisfy, regardless of source. */
function shapeViolations(c, key) {
  const v = [];
  if (typeof c.name !== "string" || !c.name.trim()) v.push("empty name");
  if (c.source !== key) v.push(`source "${c.source}" != "${key}"`);
  if (c.sourceUrl != null && !/^https?:\/\//i.test(String(c.sourceUrl))) v.push("sourceUrl not a URL");
  if (c.yearsExperience != null && typeof c.yearsExperience !== "number") v.push("yearsExperience not numeric");
  if (!Array.isArray(c.skills)) v.push("skills not an array");
  if (!Array.isArray(c.certifications)) v.push("certifications not an array");
  return v;
}

const rows = [];
const providers = listProviders().filter((p) => !SKIP.has(p.key));

console.log(`\nagent_max doctor — probing ${providers.length} providers with real calls\n`);

for (const { key } of providers) {
  const jobSpec = probeFor(key);
  const traits = traitsFor(key);
  const t0 = Date.now();
  let cands = [];
  let err = null;
  try {
    cands = await getProvider(key).search(jobSpec, {});
  } catch (e) {
    err = e.message;
  }
  const ms = Date.now() - t0;
  const n = cands.length;
  const uniqNames = new Set(cands.map((c) => String(c.name || "").toLowerCase().trim())).size;
  const withUrl = cands.filter((c) => c.sourceUrl);
  const uniqUrls = new Set(withUrl.map((c) => normUrl(c.sourceUrl))).size;
  // A provider declared entityType:"organization" (google_places, osm) is
  // expected to return businesses, not people — the NON-PERSON check would
  // just be noise there. A provider declared nameIsHandle:true (github,
  // stackoverflow, devto, huggingface, hn_hiring) returns usernames, which
  // looksLikeOrganization() was never designed to judge — skip it there too
  // rather than flag e.g. "jborden13" as a false NON-PERSON.
  const expectsPeople = traits.entityType === "person" && !traits.nameIsHandle;
  const personLike = expectsPeople ? cands.filter((c) => !looksLikeOrganization(c.name)).length : n;
  const violations = cands.flatMap((c) => shapeViolations(c, key));

  const flags = [];
  // Bug 1 signature: many records, one shared URL — but only worth flagging
  // for a provider that itself claims its sourceUrl identifies a person.
  // sebi_ria/nmc sharing one registry-listing URL is EXPECTED (traits say
  // sourceUrlIdentifiesPerson:false) and correctly handled by dedupe's
  // structural gate, not a bug to report here.
  if (traits.sourceUrlIdentifiesPerson && n > 1 && withUrl.length === n && uniqUrls === 1) {
    flags.push("SHARED-URL");
  }
  // Bug 2 signature: people-provider returning non-people.
  if (expectsPeople && n > 0 && personLike / n < 0.8) flags.push("NON-PERSON");
  if (violations.length) flags.push(`SHAPE(${violations.length})`);
  if (err) flags.push("ERROR");

  rows.push({ key, n, uniqNames, uniqUrls: withUrl.length ? uniqUrls : 0, personLike, ms, flags, err, violations: [...new Set(violations)], traits });
}

function traitsSummary(t) {
  const bits = [];
  bits.push(t.sourceUrlIdentifiesPerson ? "url=person" : "url=shared");
  if (t.nameIsHandle) bits.push("name=handle");
  if (t.dataIsLLMExtracted) bits.push("llm");
  if (t.entityType === "organization") bits.push("org");
  return bits.join(",");
}

const H = ["provider", "cand", "uniqNm", "uniqURL", "person", "ms", "flags", "traits"];
console.log(
  H[0].padEnd(15) + H[1].padStart(5) + H[2].padStart(8) + H[3].padStart(9) + H[4].padStart(8) + H[5].padStart(8) + "  " + H[6].padEnd(14) + "  " + H[7]
);
console.log("-".repeat(110));
for (const r of rows) {
  console.log(
    r.key.padEnd(15) +
      String(r.n).padStart(5) +
      String(r.uniqNames).padStart(8) +
      String(r.uniqUrls).padStart(9) +
      (r.n ? pct(r.personLike, r.n) : "    -").padStart(8) +
      String(r.ms).padStart(8) +
      "  " +
      (r.flags.length ? r.flags.join(" ") : "ok").padEnd(14) +
      "  " +
      traitsSummary(r.traits)
  );
}

console.log("\nDetail:");
let issues = 0;
for (const r of rows) {
  if (!r.flags.length) continue;
  issues++;
  console.log(`\n  ${r.key}:`);
  if (r.err) console.log(`    ERROR: ${r.err}`);
  if (r.flags.includes("SHARED-URL"))
    console.log(`    SHARED-URL: ${r.n} candidates share ${r.uniqUrls} distinct sourceUrl — url-based dedupe must NOT auto-merge these`);
  if (r.flags.includes("NON-PERSON"))
    console.log(`    NON-PERSON: only ${r.personLike}/${r.n} look like individual people`);
  for (const v of r.violations) console.log(`    SHAPE: ${v}`);
}
if (!issues) console.log("  (none)");

console.log(`\n${issues} provider(s) flagged. Zero-result providers may just be rate-limited or key-less.\n`);
