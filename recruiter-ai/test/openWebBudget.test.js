// test/openWebBudget.test.js
//
// Unit tests for the PURE budget-resolution logic in lib/providers/openWeb.js
// (resolveBudget). No network calls — this only exercises clamping/validation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBudget } from "../lib/providers/openWeb.js";

const DEFAULTS = { maxTurns: 6, timeoutMs: 25_000, maxCandidates: 10 };

test("resolveBudget: defaults when options is undefined", () => {
  assert.deepEqual(resolveBudget(undefined), DEFAULTS);
});

test("resolveBudget: defaults when options is an empty object", () => {
  assert.deepEqual(resolveBudget({}), DEFAULTS);
});

test("resolveBudget: honors valid maxTurns/timeoutMs/maxCandidates", () => {
  const budget = resolveBudget({ maxTurns: 3, timeoutMs: 10_000, maxCandidates: 5 });
  assert.deepEqual(budget, { maxTurns: 3, timeoutMs: 10_000, maxCandidates: 5 });
});

test("resolveBudget: honors a single valid field, defaults the rest", () => {
  const budget = resolveBudget({ maxTurns: 3 });
  assert.deepEqual(budget, { ...DEFAULTS, maxTurns: 3 });
});

test("resolveBudget: clamps maxTurns at the upper bound (10)", () => {
  assert.equal(resolveBudget({ maxTurns: 999 }).maxTurns, 10);
});

test("resolveBudget: clamps maxTurns at the lower bound (1)", () => {
  // 0.4 is a valid positive finite number below the min bound of 1
  assert.equal(resolveBudget({ maxTurns: 0.4 }).maxTurns, 1);
});

test("resolveBudget: clamps timeoutMs at the upper bound (60000)", () => {
  assert.equal(resolveBudget({ timeoutMs: 999_999 }).timeoutMs, 60_000);
});

test("resolveBudget: clamps timeoutMs at the lower bound (5000)", () => {
  assert.equal(resolveBudget({ timeoutMs: 1 }).timeoutMs, 5_000);
});

test("resolveBudget: clamps maxCandidates at the upper bound (25)", () => {
  assert.equal(resolveBudget({ maxCandidates: 1000 }).maxCandidates, 25);
});

test("resolveBudget: clamps maxCandidates at the lower bound (1)", () => {
  assert.equal(resolveBudget({ maxCandidates: 0.1 }).maxCandidates, 1);
});

test("resolveBudget: NaN falls back to defaults", () => {
  assert.deepEqual(resolveBudget({ maxTurns: NaN, timeoutMs: NaN, maxCandidates: NaN }), DEFAULTS);
});

test("resolveBudget: null falls back to defaults", () => {
  assert.deepEqual(resolveBudget({ maxTurns: null, timeoutMs: null, maxCandidates: null }), DEFAULTS);
});

test("resolveBudget: string values fall back to defaults", () => {
  assert.deepEqual(resolveBudget({ maxTurns: "3", timeoutMs: "10000", maxCandidates: "5" }), DEFAULTS);
});

test("resolveBudget: negative values fall back to defaults", () => {
  assert.deepEqual(resolveBudget({ maxTurns: -3, timeoutMs: -10_000, maxCandidates: -5 }), DEFAULTS);
});

test("resolveBudget: zero falls back to defaults", () => {
  assert.deepEqual(resolveBudget({ maxTurns: 0, timeoutMs: 0, maxCandidates: 0 }), DEFAULTS);
});

test("resolveBudget: non-object options (e.g. a number or string) falls back to defaults", () => {
  assert.deepEqual(resolveBudget(42), DEFAULTS);
  assert.deepEqual(resolveBudget("nope"), DEFAULTS);
});

// --- Anti-fabrication grounding gate ---------------------------------------
//
// Regression cover for a live-verified failure: the model attached names to
// pages those names never appeared on ("Tej Shah" -> planahead.in,
// "Avinash Luthria" -> nswealth.in). The second was a REAL person recalled
// from training data, bound to a page they are not on. A prompt rule was tried
// and did not hold, so the gate is structural.

import { nameWasSeen, groundLocation, groundSkills } from "../lib/providers/openWeb.js";

const PAGE = "Our team includes Vibhuti Jyotish and Dilshad Patell, Principal Officer at NS Wealth Solution Private Limited.";

test("nameWasSeen accepts a name actually present on the page", () => {
  assert.equal(nameWasSeen("Dilshad Patell", PAGE), true);
  assert.equal(nameWasSeen("Vibhuti Jyotish", PAGE), true);
});

test("nameWasSeen tolerates reordering and punctuation", () => {
  assert.equal(nameWasSeen("Patell, Dilshad", PAGE), true);
  assert.equal(nameWasSeen("dilshad  patell", PAGE), true);
});

test("nameWasSeen REJECTS a fabricated name", () => {
  assert.equal(nameWasSeen("Tej Shah", PAGE), false);
});

test("nameWasSeen REJECTS a real person recalled from memory but absent from the page", () => {
  // The exact live failure: a genuine SEBI-registered adviser, wrong page.
  assert.equal(nameWasSeen("Avinash Luthria", PAGE), false);
});

test("nameWasSeen rejects on empty/missing input rather than passing by default", () => {
  assert.equal(nameWasSeen("Anyone", ""), false);
  assert.equal(nameWasSeen("", PAGE), false);
  assert.equal(nameWasSeen(null, PAGE), false);
  assert.equal(nameWasSeen("Someone", null), false);
});

test("nameWasSeen requires ALL significant tokens, not just one", () => {
  // "Dilshad" appears but "Kapoor" does not — a partial match must not pass.
  assert.equal(nameWasSeen("Dilshad Kapoor", PAGE), false);
});

// --- P4 field grounding: location and skills (docs/DATA_QUALITY_PLAN.md P4) -
//
// Unlike nameWasSeen (drops the whole candidate), groundLocation/groundSkills
// scrub the individual field. A candidate must never be dropped merely for
// carrying an ungrounded location or skill.

const PROFILE_PAGE =
  "Dilshad Patell is a Principal Officer at NS Wealth Solution Private Limited, based in " +
  "Mumbai. He specializes in portfolio management and tax planning for retail investors.";

test("groundLocation: keeps a location that demonstrably appears in the corpus", () => {
  assert.equal(groundLocation("Mumbai", PROFILE_PAGE), "Mumbai");
});

test("groundLocation: nulls a location that does not appear anywhere in the corpus", () => {
  assert.equal(groundLocation("Bangalore", PROFILE_PAGE), null);
});

test("groundLocation: nulls empty/missing location rather than throwing", () => {
  assert.equal(groundLocation("", PROFILE_PAGE), null);
  assert.equal(groundLocation(null, PROFILE_PAGE), null);
  assert.equal(groundLocation(undefined, PROFILE_PAGE), null);
});

test("groundSkills: keeps only skills whose text appears in the corpus", () => {
  const skills = groundSkills(["portfolio management", "tax planning", "cryptocurrency trading"], PROFILE_PAGE);
  assert.deepEqual(skills, ["portfolio management", "tax planning"]);
});

test("groundSkills: drops every skill when none appear in the corpus", () => {
  assert.deepEqual(groundSkills(["cryptocurrency trading", "day trading"], PROFILE_PAGE), []);
});

test("groundSkills: non-array input returns an empty array rather than throwing", () => {
  assert.deepEqual(groundSkills(undefined, PROFILE_PAGE), []);
  assert.deepEqual(groundSkills(null, PROFILE_PAGE), []);
});

test("field grounding never drops the candidate merely for a bad location", () => {
  // Reproduces the shape of openWeb.js's own pipeline: a name-grounded
  // candidate (passes nameWasSeen) whose submitted location is NOT in the
  // corpus. The candidate must survive with location nulled, not disappear.
  const found = {
    name: "Dilshad Patell",
    sourceUrl: "https://nswealth.in/financial-advisor-mumbai",
    location: "Bangalore", // wrong / ungrounded on purpose
    skills: ["portfolio management", "cryptocurrency trading"],
  };
  assert.equal(nameWasSeen(found.name, PROFILE_PAGE), true, "sanity: the name itself is grounded");

  const location = groundLocation(found.location, PROFILE_PAGE);
  const skills = groundSkills(found.skills, PROFILE_PAGE);
  const grounded = { ...found, location, skills };

  // The candidate object itself is still present and still named/sourced —
  // only the ungrounded fields changed.
  assert.equal(grounded.name, "Dilshad Patell");
  assert.equal(grounded.sourceUrl, "https://nswealth.in/financial-advisor-mumbai");
  assert.equal(grounded.location, null);
  assert.deepEqual(grounded.skills, ["portfolio management"]);
});
