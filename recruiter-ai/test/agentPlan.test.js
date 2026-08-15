// test/agentPlan.test.js
//
// Unit tests for lib/agent/plan.js — DETERMINISTIC path only, no network.
//
// Every call below passes `{ useLLM: false }`. This is necessary, not just
// defensive: the repo's .env carries a real GROQ_API_KEY, so
// activeLLMProvider() resolves to "groq" as soon as lib/providers/googlePlaces.js
// (imported transitively by plan.js) calls dotenv.config(). Without the
// useLLM:false override, selectSources() would attempt a real network call
// to Groq on every test run. `options.useLLM` is the documented kill switch
// for exactly this (see plan.js's JSDoc and PLAN_V2.md's
// `options:{ data?, useLLM? }` route shape).

import { test } from "node:test";
import assert from "node:assert/strict";

import { selectSources } from "../lib/agent/plan.js";
import { listProviders } from "../lib/providers/index.js";
import { hasGooglePlacesKey } from "../lib/providers/googlePlaces.js";

const REGISTERED_KEYS = new Set(listProviders().map((p) => p.key));
const NO_LLM = { useLLM: false };

function assertSourcePlanShape(result) {
  assert.ok(Array.isArray(result.sources));
  assert.ok(Array.isArray(result.sourcePlan));
  assert.ok(Array.isArray(result.log));
  assert.equal(result.sources.length, result.sourcePlan.length, "sources and sourcePlan must be 1:1");

  for (const entry of result.sourcePlan) {
    assert.ok(REGISTERED_KEYS.has(entry.providerKey), `${entry.providerKey} must be a real registered provider key`);
    assert.equal(typeof entry.reason, "string");
    assert.ok(entry.reason.trim().length > 0, `sourcePlan entry for ${entry.providerKey} must have a non-empty reason`);
  }

  // sources[] must exactly match sourcePlan[].providerKey, in order
  assert.deepEqual(result.sources, result.sourcePlan.map((e) => e.providerKey));
}

// ---------------------------------------------------------------------------
// Field -> deterministic source mapping
// ---------------------------------------------------------------------------

test("selectSources: software field maps to github, stackoverflow, hn_hiring, devto, huggingface", async () => {
  const result = await selectSources({ field: "software", title: "Backend Engineer" }, NO_LLM);
  assertSourcePlanShape(result);
  assert.deepEqual(new Set(result.sources), new Set(["github", "stackoverflow", "hn_hiring", "devto", "huggingface"]));
});

test("selectSources: finance field maps to sebi_ria, finra", async () => {
  const result = await selectSources({ field: "finance", title: "Investment Adviser" }, NO_LLM);
  assertSourcePlanShape(result);
  assert.deepEqual(new Set(result.sources), new Set(["sebi_ria", "finra"]));
});

test("selectSources: healthcare field maps to nmc, npi", async () => {
  const result = await selectSources({ field: "healthcare", title: "Physician" }, NO_LLM);
  assertSourcePlanShape(result);
  assert.deepEqual(new Set(result.sources), new Set(["nmc", "npi"]));
});

test("selectSources: research field maps to orcid, openalex", async () => {
  const result = await selectSources({ field: "research", title: "Research Scientist" }, NO_LLM);
  assertSourcePlanShape(result);
  assert.deepEqual(new Set(result.sources), new Set(["orcid", "openalex"]));
});

// ---------------------------------------------------------------------------
// `sample` is never present in auto mode
// ---------------------------------------------------------------------------

test("selectSources: 'sample' is never present, for any field", async () => {
  for (const field of ["software", "finance", "healthcare", "research", "sales", "marketing", "", undefined]) {
    const result = await selectSources({ field, location: "Austin, TX" }, NO_LLM);
    assert.ok(!result.sources.includes("sample"), `sample leaked in for field=${field}`);
  }
});

// ---------------------------------------------------------------------------
// Location-anchored sources (google_places / osm)
// ---------------------------------------------------------------------------

test("selectSources: google_places/osm absent when location is empty or null", async () => {
  const noLocation = await selectSources({ field: "software", location: "" }, NO_LLM);
  assert.ok(!noLocation.sources.includes("google_places"));
  assert.ok(!noLocation.sources.includes("osm"));

  const nullLocation = await selectSources({ field: "software", location: null }, NO_LLM);
  assert.ok(!nullLocation.sources.includes("google_places"));
  assert.ok(!nullLocation.sources.includes("osm"));

  const missingLocation = await selectSources({ field: "software" }, NO_LLM);
  assert.ok(!missingLocation.sources.includes("google_places"));
  assert.ok(!missingLocation.sources.includes("osm"));
});

test("selectSources: osm present (and google_places present iff a key is configured) when a location is given", async () => {
  const result = await selectSources({ field: "software", location: "San Francisco, CA" }, NO_LLM);
  assertSourcePlanShape(result);
  assert.ok(result.sources.includes("osm"), "osm needs no key and should be included when a location is given");

  if (hasGooglePlacesKey()) {
    assert.ok(result.sources.includes("google_places"));
  } else {
    assert.ok(!result.sources.includes("google_places"), "google_places must be dropped without GOOGLE_PLACES_API_KEY");
    assert.ok(
      result.log.some((line) => line.includes("google_places")),
      "dropping google_places for lack of a key must be logged"
    );
  }
});

// ---------------------------------------------------------------------------
// Optional upload
// ---------------------------------------------------------------------------

test("selectSources: upload included only when options.data is provided", async () => {
  const withData = await selectSources({ field: "healthcare" }, { ...NO_LLM, data: "name,skills\nJane,python" });
  assert.ok(withData.sources.includes("upload"));

  const withoutData = await selectSources({ field: "healthcare" }, NO_LLM);
  assert.ok(!withoutData.sources.includes("upload"));

  const emptyData = await selectSources({ field: "healthcare" }, { ...NO_LLM, data: "" });
  assert.ok(!emptyData.sources.includes("upload"));

  const whitespaceOnlyData = await selectSources({ field: "healthcare" }, { ...NO_LLM, data: "   " });
  assert.ok(!whitespaceOnlyData.sources.includes("upload"));
});

// ---------------------------------------------------------------------------
// Unknown / unmapped field
// ---------------------------------------------------------------------------

test("selectSources: an unknown/unmapped field does not throw and returns a sensible list", async () => {
  const result = await selectSources({ field: "underwater basket weaving", location: "Remote" }, NO_LLM);
  assertSourcePlanShape(result);
  // No field mapping exists, but a location was given, so the
  // location-anchored, no-key-required source (osm) still shows up —
  // a non-empty, honest result rather than a thrown error.
  assert.ok(result.sources.includes("osm"));
});

test("selectSources: an unknown field with no location and no upload returns an empty-but-valid result, never throws", async () => {
  const result = await selectSources({ field: "underwater basket weaving" }, NO_LLM);
  assertSourcePlanShape(result);
  assert.deepEqual(result.sources, []);
  assert.ok(result.log.length > 0, "an empty plan should still explain itself in the log");
});

// ---------------------------------------------------------------------------
// sourcePlan shape (general)
// ---------------------------------------------------------------------------

test("selectSources: sourcePlan has one entry per source, each with a non-empty reason", async () => {
  const result = await selectSources({ field: "software", location: "New York, NY" }, NO_LLM);
  assertSourcePlanShape(result);
  assert.ok(result.sourcePlan.length >= 5);
});

// ---------------------------------------------------------------------------
// Every returned key is real (cross-checked against the live registry)
// ---------------------------------------------------------------------------

test("selectSources: every returned key across all fields is a real registered provider key", async () => {
  const fields = ["software", "finance", "healthcare", "research", "unknown-field"];
  for (const field of fields) {
    const result = await selectSources({ field, location: "Chicago, IL" }, { ...NO_LLM, data: "name\nA" });
    for (const key of result.sources) {
      assert.ok(REGISTERED_KEYS.has(key), `"${key}" (field=${field}) is not a registered provider key`);
    }
  }
});
