// lib/agent/trust.js
//
// The per-SOURCE trust prior, shared by dedupe.js (to pick which record wins a
// merge) and consolidate.js (as one of the two ranking axes). Kept in its own
// tiny module so neither of those depends on the other.
//
// WHY TRUST IS SEPARATE FROM DATA COMPLETENESS (see PLAN_V2.md §4 P2):
// they are orthogonal. An `open_web` result can be highly COMPLETE — an LLM
// filled in every field from a portfolio page — while being entirely
// UNVERIFIED. Completeness alone would rank that above a government-registry
// professional. Trust is what prevents that.
//
// Tiers:
//   verified — official registries + the recruiter's own data. A named human
//              exists and some authority (or the recruiter) vouched for them.
//   profile  — a real, self-maintained public profile on a platform with an
//              API. Real person, but nobody verified the claims.
//   lead     — a thin or inferred hit. Might be a real person, might be a
//              business listing or an LLM's reading of a web page.
//
// Exports:
//   SOURCE_TRUST                 providerKey -> tier
//   TRUST_RANK                   tier -> number (higher wins)
//   trustFor(sourceKey)          tier, defaulting to "lead" for unknown keys
//   compareTrust(a, b)           positive when a is more trusted than b

export const SOURCE_TRUST = Object.freeze({
  // verified — official/regulatory registries, and data the recruiter supplied
  sebi_ria: "verified", // SEBI Registered Investment Advisers (India, official)
  nmc: "verified", // National Medical Commission doctor registry (India, official)
  npi: "verified", // NPI Registry (US CMS, official)
  finra: "verified", // FINRA BrokerCheck (US regulator, official)
  upload: "verified", // the recruiter's own CSV/JSON — they vouch for it

  // profile — real public profiles with real APIs, but unvouched claims
  github: "profile",
  stackoverflow: "profile",
  hn_hiring: "profile",
  devto: "profile",
  huggingface: "profile",
  orcid: "profile",
  openalex: "profile",
  google_places: "profile",

  // lead — thin, inferred, or synthetic; always needs human click-through
  osm: "lead",
  open_web: "lead",
  sample: "lead", // synthetic demo data; excluded from auto mode, tiered low if it ever appears
});

export const TRUST_RANK = Object.freeze({ verified: 3, profile: 2, lead: 1 });

/** Trust tier for a provider key. Unknown sources are treated as "lead" —
 * a new provider must be explicitly promoted, never trusted by default. */
export function trustFor(sourceKey) {
  return SOURCE_TRUST[String(sourceKey || "")] || "lead";
}

/** >0 when a is more trusted than b, <0 when less, 0 when equal. */
export function compareTrust(a, b) {
  return (TRUST_RANK[trustFor(a)] || 1) - (TRUST_RANK[trustFor(b)] || 1);
}
