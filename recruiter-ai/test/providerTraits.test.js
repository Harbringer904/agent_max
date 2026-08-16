// test/providerTraits.test.js
//
// Unit tests for lib/providers/traits.js — docs/DATA_QUALITY_PLAN.md P2.

import { test } from "node:test";
import assert from "node:assert/strict";
import { listProviders } from "../lib/providers/index.js";
import { traitsFor, SAFE_DEFAULT_TRAITS } from "../lib/providers/traits.js";
import { dedupeCandidates } from "../lib/agent/dedupe.js";

const REQUIRED_KEYS = ["sourceUrlIdentifiesPerson", "nameIsHandle", "dataIsLLMExtracted", "entityType"];

function candidate(overrides = {}) {
  return {
    id: overrides.id || "id",
    name: "",
    headline: "",
    field: "",
    location: null,
    yearsExperience: null,
    education: null,
    educationLevel: null,
    skills: [],
    certifications: [],
    summary: null,
    source: "sample",
    sourceUrl: null,
    avatarUrl: null,
    raw: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Every registered provider exposes complete traits
// ---------------------------------------------------------------------------

test("every registered provider declares a complete traits object", () => {
  const providers = listProviders();
  assert.ok(providers.length > 0, "sanity: providers are actually registered");

  for (const { key } of providers) {
    const traits = traitsFor(key);
    for (const k of REQUIRED_KEYS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(traits, k),
        `${key}: traitsFor() result missing "${k}"`
      );
    }
    assert.equal(typeof traits.sourceUrlIdentifiesPerson, "boolean", `${key}: sourceUrlIdentifiesPerson must be boolean`);
    assert.equal(typeof traits.nameIsHandle, "boolean", `${key}: nameIsHandle must be boolean`);
    assert.equal(typeof traits.dataIsLLMExtracted, "boolean", `${key}: dataIsLLMExtracted must be boolean`);
    assert.ok(
      traits.entityType === "person" || traits.entityType === "organization",
      `${key}: entityType must be "person" or "organization", got "${traits.entityType}"`
    );
  }
});

// Ground-truth spot checks against docs/DATA_QUALITY_PLAN.md's verified doctor
// output, so a future edit that silently flips a provider's declared trait
// back to a dangerous default gets caught here, not by a human re-running
// `npm run doctor`.
test("sebi_ria and nmc declare sourceUrlIdentifiesPerson:false (shared registry listing URL)", () => {
  assert.equal(traitsFor("sebi_ria").sourceUrlIdentifiesPerson, false);
  assert.equal(traitsFor("nmc").sourceUrlIdentifiesPerson, false);
});

test("github, stackoverflow, devto, huggingface, hn_hiring declare nameIsHandle:true", () => {
  for (const key of ["github", "stackoverflow", "devto", "huggingface", "hn_hiring"]) {
    assert.equal(traitsFor(key).nameIsHandle, true, `${key} should declare nameIsHandle:true`);
  }
});

test("open_web declares dataIsLLMExtracted:true", () => {
  assert.equal(traitsFor("open_web").dataIsLLMExtracted, true);
});

test("google_places and osm declare entityType:organization", () => {
  assert.equal(traitsFor("google_places").entityType, "organization");
  assert.equal(traitsFor("osm").entityType, "organization");
});

test("npi, finra, orcid, openalex, sebi_ria, nmc, upload, sample declare entityType:person", () => {
  for (const key of ["npi", "finra", "orcid", "openalex", "sebi_ria", "nmc", "upload", "sample"]) {
    assert.equal(traitsFor(key).entityType, "person", `${key} should declare entityType:person`);
  }
});

// ---------------------------------------------------------------------------
// traitsFor() safe defaults for an unknown key
// ---------------------------------------------------------------------------

test("traitsFor() returns SAFE_DEFAULT_TRAITS for an unknown provider key", () => {
  assert.deepEqual(traitsFor("no_such_provider"), SAFE_DEFAULT_TRAITS);
  assert.deepEqual(traitsFor(""), SAFE_DEFAULT_TRAITS);
  assert.deepEqual(traitsFor(undefined), SAFE_DEFAULT_TRAITS);
  assert.deepEqual(traitsFor(null), SAFE_DEFAULT_TRAITS);
});

test("SAFE_DEFAULT_TRAITS is the conservative interpretation on every axis", () => {
  assert.deepEqual(SAFE_DEFAULT_TRAITS, {
    sourceUrlIdentifiesPerson: false,
    nameIsHandle: false,
    dataIsLLMExtracted: true,
    entityType: "person",
  });
});

// ---------------------------------------------------------------------------
// dedupe.js actually reads these traits back (integration, not just unit)
// ---------------------------------------------------------------------------

test("dedupe does NOT url-merge two different people sharing a sebi_ria listing URL", () => {
  const registryUrl = "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=13";
  const a = candidate({ id: "a", name: "Abhishek Kumar", source: "sebi_ria", sourceUrl: registryUrl });
  const b = candidate({ id: "b", name: "Anup Kalra", source: "sebi_ria", sourceUrl: registryUrl });

  const { candidates } = dedupeCandidates([a, b]);

  assert.equal(candidates.length, 2, "distinct advisers sharing a registry listing URL must not collapse");
});

test("dedupe DOES url-merge two records sharing a github profile URL", () => {
  const a = candidate({ id: "a", name: "Jane Doe", source: "github", sourceUrl: "https://github.com/janedoe" });
  const b = candidate({ id: "b", name: "Jane Doe", source: "github", sourceUrl: "https://github.com/janedoe" });

  const { candidates } = dedupeCandidates([a, b]);

  assert.equal(candidates.length, 1, "a real per-person permalink must still drive tier-1 url-merge");
});
