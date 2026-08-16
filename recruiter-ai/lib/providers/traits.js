// lib/providers/traits.js
//
// docs/DATA_QUALITY_PLAN.md P2 — provider capability metadata.
//
// WHY THIS EXISTS: today dedupe.js and doctor.mjs each GUESS what a
// provider's sourceUrl/name means. That guess was wrong for sebi_ria/nmc
// (shared registry listing URL, not a per-person permalink) and for
// hn_hiring (a HN username, not a personal name) — both caught live, not by
// any test. Providers now DECLARE these facts on their own `provider.traits`
// object; this module is the single place that reads them back out.
//
// SAFE DEFAULTS: a provider that forgets to declare `traits` (a brand-new
// provider someone adds without reading this file) must NOT silently inherit
// a dangerous assumption. So every default is the most conservative answer:
//   - sourceUrlIdentifiesPerson: false -> never trust a shared sourceUrl to
//     mean "same person" until a provider proves otherwise. Under-merging
//     (two rows for one person) is a minor annoyance; over-merging (one row
//     silently absorbing many distinct people) is the actual bug class this
//     plan exists to prevent.
//   - nameIsHandle: false -> don't second-guess a name's trustworthiness
//     unless a provider says it's a handle.
//   - dataIsLLMExtracted: true -> assume the *riskiest* case (ungrounded,
//     possibly-fabricated data needing extra scrutiny) rather than the safe
//     one, so a new provider is never accidentally treated as "just trust it".
//   - entityType: "person" -> the app's default subject; a provider must
//     opt IN to "organization", not the other way around.
//
// Exports:
//   SAFE_DEFAULT_TRAITS   the defaults documented above, frozen
//   traitsFor(providerKey) -> a provider's declared traits merged over
//                             SAFE_DEFAULT_TRAITS (unknown/missing keys ->
//                             pure defaults)

import { getProvider } from "./index.js";

export const SAFE_DEFAULT_TRAITS = Object.freeze({
  sourceUrlIdentifiesPerson: false,
  nameIsHandle: false,
  dataIsLLMExtracted: true,
  entityType: "person",
});

/**
 * @param {string} providerKey
 * @returns {{sourceUrlIdentifiesPerson: boolean, nameIsHandle: boolean, dataIsLLMExtracted: boolean, entityType: "person"|"organization"}}
 */
export function traitsFor(providerKey) {
  let declared = null;
  try {
    declared = getProvider(providerKey)?.traits ?? null;
  } catch {
    // Unknown provider key -> pure safe defaults.
    declared = null;
  }
  return {
    ...SAFE_DEFAULT_TRAITS,
    ...(declared && typeof declared === "object" ? declared : {}),
  };
}
