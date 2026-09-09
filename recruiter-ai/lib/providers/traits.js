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
    declared = null;
  }
  return {
    ...SAFE_DEFAULT_TRAITS,
    ...(declared && typeof declared === "object" ? declared : {}),
  };
}
