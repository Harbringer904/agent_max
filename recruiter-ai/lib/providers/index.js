// lib/providers/index.js
//
// Provider registry — the single place that knows which providers exist.
//
// Exports:
//   getProvider(key)   -> provider object (throws on unknown key)
//   listProviders()    -> [{ key, label, fields }]

import { provider as github } from "./github.js";
import { provider as sample } from "./sample.js";
import { provider as upload } from "./upload.js";
import { provider as stackoverflow } from "./stackoverflow.js";

const PROVIDERS = { github, sample, upload, stackoverflow };

export function getProvider(key) {
  const provider = PROVIDERS[key];
  if (!provider) throw new Error(`Unknown provider: "${key}"`);
  return provider;
}

export function listProviders() {
  return Object.values(PROVIDERS).map(({ key, label, fields }) => ({ key, label, fields }));
}
