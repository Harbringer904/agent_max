export const SOURCE_TRUST = Object.freeze({
  sebi_ria: "verified",
  nmc: "verified",
  npi: "verified",
  finra: "verified",
  upload: "verified",

  github: "profile",
  stackoverflow: "profile",
  hn_hiring: "profile",
  devto: "profile",
  huggingface: "profile",
  orcid: "profile",
  openalex: "profile",
  google_places: "profile",

  osm: "lead",
  open_web: "lead",
  sample: "lead",
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
