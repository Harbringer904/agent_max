// test/normalize.test.js
//
// Unit tests for lib/normalize.js — asserts REAL current behavior.

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCandidate, educationLevelFromText, EDUCATION_LEVELS } from "../lib/normalize.js";

// ---------------------------------------------------------------------------
// normalizeCandidate — defaults, coercion, id fallback
// ---------------------------------------------------------------------------

test("normalizeCandidate: fills every field with its default on an empty partial", () => {
  const c = normalizeCandidate({}, "sample", 3);
  assert.deepEqual(c, {
    id: "sample:3",
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
  });
});

test("normalizeCandidate: id falls back to `${sourceKey}:${name}` when name present and id absent", () => {
  const c = normalizeCandidate({ name: "Jane Doe" }, "upload", 7);
  assert.equal(c.id, "upload:Jane Doe");
});

test("normalizeCandidate: id falls back to `${sourceKey}:${index}` when name and id both absent", () => {
  const c = normalizeCandidate({}, "upload", 7);
  assert.equal(c.id, "upload:7");
});

test("normalizeCandidate: explicit id is preserved over the fallback", () => {
  const c = normalizeCandidate({ id: "custom-id", name: "Jane" }, "upload", 0);
  assert.equal(c.id, "custom-id");
});

test("normalizeCandidate: index defaults to 0 when omitted", () => {
  const c = normalizeCandidate({}, "sample");
  assert.equal(c.id, "sample:0");
});

test("normalizeCandidate: numeric fields coerce strings, reject non-finite, and null on blank/absent", () => {
  assert.equal(normalizeCandidate({ yearsExperience: "5" }, "s").yearsExperience, 5);
  assert.equal(normalizeCandidate({ yearsExperience: "" }, "s").yearsExperience, null);
  assert.equal(normalizeCandidate({ yearsExperience: undefined }, "s").yearsExperience, null);
  assert.equal(normalizeCandidate({ yearsExperience: "not-a-number" }, "s").yearsExperience, null);
  assert.equal(normalizeCandidate({ yearsExperience: 0 }, "s").yearsExperience, 0);
});

test("normalizeCandidate: educationLevel is derived from education text when not given explicitly", () => {
  const c = normalizeCandidate({ education: "Master of Science" }, "s");
  assert.equal(c.educationLevel, EDUCATION_LEVELS.master);
});

test("normalizeCandidate: explicit educationLevel takes precedence over derivation from text", () => {
  const c = normalizeCandidate({ education: "Master of Science", educationLevel: 1 }, "s");
  assert.equal(c.educationLevel, 1);
});

test("normalizeCandidate: educationLevel stays null when education text is unrecognizable", () => {
  const c = normalizeCandidate({ education: "some unrelated text" }, "s");
  assert.equal(c.educationLevel, null);
});

test("normalizeCandidate: skills/certifications coerce array elements to trimmed strings, drop blanks", () => {
  const c = normalizeCandidate({ skills: [" python ", "", "sql", 42] }, "s");
  assert.deepEqual(c.skills, ["python", "sql", "42"]);
});

test("normalizeCandidate: non-array skills/certifications become []", () => {
  const c = normalizeCandidate({ skills: "python", certifications: null }, "s");
  assert.deepEqual(c.skills, []);
  assert.deepEqual(c.certifications, []);
});

test("normalizeCandidate: string fields fall back to '' (required) vs null (optional)", () => {
  const c = normalizeCandidate({ name: null, location: undefined, summary: "" }, "s");
  assert.equal(c.name, ""); // required field
  assert.equal(c.location, null); // optional field
  assert.equal(c.summary, null); // blank string treated as absent
});

test("normalizeCandidate: raw is kept when an object, otherwise {}", () => {
  const withRaw = normalizeCandidate({ raw: { foo: "bar" } }, "s");
  assert.deepEqual(withRaw.raw, { foo: "bar" });
  const withoutRaw = normalizeCandidate({ raw: "not-an-object" }, "s");
  assert.deepEqual(withoutRaw.raw, {});
});

test("normalizeCandidate: source is always the passed sourceKey regardless of partial content", () => {
  const c = normalizeCandidate({ source: "spoofed" }, "sample");
  assert.equal(c.source, "sample");
});

test("normalizeCandidate: non-object partial (null/undefined) is treated as {}", () => {
  const c1 = normalizeCandidate(null, "s", 1);
  const c2 = normalizeCandidate(undefined, "s", 1);
  assert.equal(c1.id, "s:1");
  assert.equal(c2.id, "s:1");
});

// ---------------------------------------------------------------------------
// educationLevelFromText — mappings
// ---------------------------------------------------------------------------

test("educationLevelFromText: phd/doctorate variants map to 5", () => {
  assert.equal(educationLevelFromText("PhD in Computer Science"), 5);
  assert.equal(educationLevelFromText("Ph.D. in Computer Science"), 5);
  assert.equal(educationLevelFromText("Doctorate in Nursing Practice"), 5);
});

test("educationLevelFromText: master/mba variants map to 4", () => {
  assert.equal(educationLevelFromText("Master of Science"), 4);
  assert.equal(educationLevelFromText("MBA"), 4);
  assert.equal(educationLevelFromText("MSc in Data Science"), 4);
});

test("educationLevelFromText: bachelor variants map to 3", () => {
  assert.equal(educationLevelFromText("Bachelor of Arts"), 3);
  assert.equal(educationLevelFromText("BSc Computer Science"), 3);
});

test("educationLevelFromText: associate maps to 2", () => {
  assert.equal(educationLevelFromText("Associate Degree in Nursing"), 2);
});

test("educationLevelFromText: high school variants map to 1", () => {
  assert.equal(educationLevelFromText("High School Diploma"), 1);
  assert.equal(educationLevelFromText("GED"), 1);
});

test("educationLevelFromText: unrecognizable/junk text and blank input map to null", () => {
  assert.equal(educationLevelFromText("underwater basket weaving"), null);
  assert.equal(educationLevelFromText(""), null);
  assert.equal(educationLevelFromText(null), null);
  assert.equal(educationLevelFromText(undefined), null);
});
