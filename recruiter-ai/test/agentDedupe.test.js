// test/agentDedupe.test.js
//
// Unit tests for lib/agent/dedupe.js — PLAN_V2.md §4 P3.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeCandidates } from "../lib/agent/dedupe.js";

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
// Tier 1: identical sourceUrl -> auto-merge
// ---------------------------------------------------------------------------

test("dedupe: identical sourceUrl (www/trailing-slash/query variants) auto-merges into one record", () => {
  const a = candidate({
    id: "gh:1",
    name: "Jane Doe",
    source: "github",
    sourceUrl: "https://github.com/janedoe",
  });
  const b = candidate({
    id: "so:1",
    name: "Jane Doe",
    source: "stackoverflow",
    sourceUrl: "http://www.github.com/janedoe/",
  });
  const c = candidate({
    id: "web:1",
    name: "Jane Doe",
    source: "open_web",
    sourceUrl: "https://GitHub.com/janedoe?tab=repositories",
  });

  const { candidates, log } = dedupeCandidates([a, b, c]);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].provenance.length, 3);
  assert.ok(log.some((l) => /by url/.test(l)));
});

test("dedupe: union of skills/certifications on merge, and null-filling of scalars", () => {
  const a = candidate({
    id: "gh:1",
    name: "Jane Doe",
    source: "github",
    sourceUrl: "https://github.com/janedoe",
    skills: ["Rust", "Go"],
    certifications: [],
    location: null,
    yearsExperience: null,
  });
  const b = candidate({
    id: "web:1",
    name: "Jane Doe",
    source: "open_web",
    sourceUrl: "https://github.com/janedoe",
    skills: ["rust", "Python"],
    certifications: ["AWS Certified"],
    location: "Austin, TX",
    yearsExperience: 6,
  });

  const { candidates } = dedupeCandidates([a, b]);

  assert.equal(candidates.length, 1);
  const merged = candidates[0];
  // case-insensitive union, first-seen casing preserved ("Rust" not "rust")
  assert.deepEqual(merged.skills.sort(), ["Go", "Python", "Rust"].sort());
  assert.deepEqual(merged.certifications, ["AWS Certified"]);
  // github ("profile") outranks open_web ("lead"), so a is primary; b's
  // non-empty scalars fill a's null location/yearsExperience
  assert.equal(merged.location, "Austin, TX");
  assert.equal(merged.yearsExperience, 6);
});

test("dedupe: higher-trust source wins as primary on URL merge (nmc beats open_web)", () => {
  const verified = candidate({
    id: "nmc:1",
    name: "Dr. Asha Rao",
    source: "nmc",
    sourceUrl: "https://nmc.example.org/doctor/asha-rao",
    headline: "Registered Physician",
  });
  const lead = candidate({
    id: "web:1",
    name: "Asha Rao",
    source: "open_web",
    sourceUrl: "https://nmc.example.org/doctor/asha-rao",
    headline: "Some web summary",
  });

  const { candidates } = dedupeCandidates([lead, verified]);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].source, "nmc");
  assert.equal(candidates[0].headline, "Registered Physician");
});

test("dedupe: provenance lists both sources after a URL merge", () => {
  const a = candidate({ id: "a", source: "github", sourceUrl: "https://github.com/x" });
  const b = candidate({ id: "b", source: "open_web", sourceUrl: "https://github.com/x/" });

  const { candidates } = dedupeCandidates([a, b]);

  assert.equal(candidates.length, 1);
  const sources = candidates[0].provenance.map((p) => p.source).sort();
  assert.deepEqual(sources, ["github", "open_web"]);
});

// ---------------------------------------------------------------------------
// Tier 2: name match + >=2 corroborating signals -> corroborated merge
// ---------------------------------------------------------------------------

test("dedupe: name match + 2 corroborating signals (location + skill) -> merged with mergedFrom set", () => {
  const a = candidate({
    id: "gh:1",
    name: "John Smith",
    source: "github",
    location: "San Francisco, CA",
    skills: ["Kubernetes", "Go"],
    headline: "Backend engineer",
  });
  const b = candidate({
    id: "web:1",
    name: "John Smith",
    source: "open_web",
    location: "San Francisco", // substring of a's "San Francisco, CA"
    skills: ["kubernetes"],
    headline: "Infra person",
  });

  const { candidates, log } = dedupeCandidates([a, b]);

  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].mergedFrom.sort(), ["gh:1", "web:1"].sort());
  assert.ok(log.some((l) => /corroborated/.test(l)));
});

// ---------------------------------------------------------------------------
// Tier 3: name match + <2 signals -> flag only, never merged
// ---------------------------------------------------------------------------

test("dedupe: name match + only 1 corroborating signal -> NOT merged, both kept, possibleDuplicateOf set", () => {
  const a = candidate({
    id: "gh:1",
    name: "John Smith",
    source: "github",
    location: "San Francisco, CA",
    skills: ["Kubernetes"],
    headline: "Backend engineer at Acme",
  });
  const b = candidate({
    id: "web:1",
    name: "John Smith",
    source: "open_web",
    location: null, // no location overlap possible
    skills: ["Photoshop"], // no shared skill
    headline: "Backend engineer at Acme", // shared distinctive token(s): "backend"/"acme" -> 1 signal
  });

  const { candidates, log } = dedupeCandidates([a, b]);

  assert.equal(candidates.length, 2);
  const [gh, web] = [
    candidates.find((c) => c.id === "gh:1"),
    candidates.find((c) => c.id === "web:1"),
  ];
  assert.ok(gh && web);
  assert.equal(gh.mergedFrom, undefined);
  assert.equal(web.mergedFrom, undefined);
  // github is more trusted (profile) than open_web (lead) -> github is the anchor
  assert.equal(web.possibleDuplicateOf, "gh:1");
  assert.equal(gh.possibleDuplicateOf, undefined);
  assert.ok(log.some((l) => /flagged/.test(l)));
});

test("dedupe: two genuinely different people sharing a common name -> NOT merged", () => {
  const a = candidate({
    id: "gh:1",
    name: "Michael Johnson",
    source: "github",
    location: "Seattle, WA",
    skills: ["Java", "Spring"],
    headline: "Java backend developer",
  });
  const b = candidate({
    id: "so:1",
    name: "Michael Johnson",
    source: "stackoverflow",
    location: "London, UK",
    skills: ["Ruby", "Rails"],
    headline: "Frontend hobbyist",
  });

  const { candidates } = dedupeCandidates([a, b]);

  // Both distinct records are preserved (not collapsed into one row).
  assert.equal(candidates.length, 2);
  assert.ok(candidates.some((c) => c.id === "gh:1" && c.skills.includes("Java")));
  assert.ok(candidates.some((c) => c.id === "so:1" && c.skills.includes("Ruby")));
});

// ---------------------------------------------------------------------------
// Defensive behavior
// ---------------------------------------------------------------------------

test("dedupe: empty array does not throw and returns empty result", () => {
  const { candidates, log } = dedupeCandidates([]);
  assert.deepEqual(candidates, []);
  assert.ok(Array.isArray(log));
});

test("dedupe: non-array input does not throw", () => {
  assert.doesNotThrow(() => dedupeCandidates(null));
  assert.doesNotThrow(() => dedupeCandidates(undefined));
  assert.doesNotThrow(() => dedupeCandidates("not an array"));
  const { candidates } = dedupeCandidates(null);
  assert.deepEqual(candidates, []);
});

test("dedupe: malformed entries (null, missing fields) in the array do not throw", () => {
  const good = candidate({ id: "ok", name: "Someone Fine" });
  assert.doesNotThrow(() => dedupeCandidates([null, undefined, 42, "oops", {}, good]));
  const { candidates } = dedupeCandidates([null, undefined, 42, "oops", {}, good]);
  // null/undefined/non-object entries are dropped; {} and the valid record survive
  assert.equal(candidates.length, 2);
});

test("dedupe: two candidates with no name and no sourceUrl are never merged together", () => {
  const a = candidate({ id: "a", name: "" });
  const b = candidate({ id: "b", name: "" });
  const { candidates } = dedupeCandidates([a, b]);
  assert.equal(candidates.length, 2);
});

// --- Regression: non-identifying (registry listing) sourceUrl ---------------
//
// Found live, not in review: sebi_ria and nmc have no per-person permalink, so
// EVERY record they return carries the same registry search-page URL. Blind
// url-merging collapsed 25 distinct SEBI advisers (and 20 NMC doctors) into a
// single candidate — silently deleting real, distinct people, which is the
// worst failure mode this module exists to prevent.

test("shared registry url with conflicting names does NOT merge distinct people", () => {
  const registryUrl = "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doRecognisedFpi=yes&intmId=13";
  const people = ["Abhishek Kumar", "Anup Kalra", "Anudeep Yadav", "Arun Ramabhadran"].map((name, i) =>
    candidate({ id: `sebi:${i}`, name, source: "sebi_ria", sourceUrl: registryUrl })
  );
  const { candidates } = dedupeCandidates(people);
  assert.equal(candidates.length, 4, "four distinct advisers must survive a shared registry URL");
  assert.deepEqual(
    candidates.map((c) => c.name).sort(),
    ["Abhishek Kumar", "Anudeep Yadav", "Anup Kalra", "Arun Ramabhadran"]
  );
});

test("shared url WITH matching names still auto-merges (genuine duplicate)", () => {
  const url = "https://example.org/registry";
  const a = candidate({ id: "a", name: "Jane Roe", source: "sebi_ria", sourceUrl: url, skills: ["tax"] });
  const b = candidate({ id: "b", name: "Jane Roe", source: "open_web", sourceUrl: url, skills: ["audit"] });
  const { candidates } = dedupeCandidates([a, b]);
  assert.equal(candidates.length, 1, "same name + same url is a real duplicate");
  assert.equal(candidates[0].source, "sebi_ria", "higher-trust source survives as primary");
});
