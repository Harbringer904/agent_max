// lib/providers/index.js
//
// Provider registry — the single place that knows which providers exist.
//
// Exports:
//   getProvider(key)              -> provider object (throws on unknown key)
//   listProviders()                -> [{ key, label, fields }]
//   defaultProviderForField(field) -> provider key

import { provider as github } from "./github.js";
import { provider as sample } from "./sample.js";
import { provider as upload } from "./upload.js";
import { provider as stackoverflow } from "./stackoverflow.js";
import { provider as googlePlaces } from "./googlePlaces.js";
import { provider as sebiRia } from "./sebiRia.js";

const PROVIDERS = {
  github,
  sample,
  upload,
  stackoverflow,
  google_places: googlePlaces,
  sebi_ria: sebiRia,
};

/** The provider a field should search by default when the user hasn't
 * explicitly chosen one — used by the "combine with our database" upload
 * option. Falls back to "sample" (always available for every field). */
export function defaultProviderForField(field) {
  const f = String(field || "").toLowerCase().trim();
  if (f === "finance") return "sebi_ria";
  return "sample";
}

export function getProvider(key) {
  const provider = PROVIDERS[key];
  if (!provider) throw new Error(`Unknown provider: "${key}"`);
  return provider;
}

export function listProviders() {
  return Object.values(PROVIDERS).map(({ key, label, fields }) => ({ key, label, fields }));
}
