// test/providers.test.js
//
// Unit tests for lib/providers/upload.js and lib/providers/sample.js —
// asserts REAL current behavior. github.js is excluded (network I/O).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

import { provider as uploadProvider } from "../lib/providers/upload.js";
import { provider as sampleProvider } from "../lib/providers/sample.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = path.join(__dirname, "..", "data", "samples");

// ---------------------------------------------------------------------------
// upload provider — CSV parsing
// ---------------------------------------------------------------------------

test("upload.search: parses CSV with a quoted comma field and ';'-split skills/certifications", async () => {
  const csv = [
    "name,skills,certifications,location,experience,education,summary",
    '"Doe, Jane",python;sql;react,AWS;GCP,Austin,5,Bachelor of Science,"Loves data, dashboards, and growth"',
  ].join("\n");

  const result = await uploadProvider.search({ field: "sales" }, { data: csv });

  assert.equal(result.length, 1);
  const c = result[0];
  assert.equal(c.name, "Doe, Jane");
  assert.deepEqual(c.skills, ["python", "sql", "react"]);
  assert.deepEqual(c.certifications, ["AWS", "GCP"]);
  assert.equal(c.location, "Austin");
  assert.equal(c.yearsExperience, 5);
  assert.equal(c.education, "Bachelor of Science");
  assert.equal(c.summary, "Loves data, dashboards, and growth");
  assert.equal(c.headline, "Loves data, dashboards, and growth"); // falls back to summary
  assert.equal(c.field, "sales");
  assert.equal(c.source, "upload");
  assert.equal(c.educationLevel, 3); // derived from "Bachelor of Science"
});

test("upload.search: CSV headline falls back to name when summary is also absent", async () => {
  const csv = ["name,skills", "John Smith,python"].join("\n");
  const result = await uploadProvider.search({ field: "software" }, { data: csv });
  assert.equal(result.length, 1);
  assert.equal(result[0].headline, "John Smith");
});

// ---------------------------------------------------------------------------
// upload provider — JSON parsing
// ---------------------------------------------------------------------------

test("upload.search: parses a JSON array into normalized Candidates", async () => {
  const json = JSON.stringify([
    { name: "A", skills: ["x", "y"] },
    { name: "B", field: "engineering", skills: ["z"] },
  ]);
  const result = await uploadProvider.search({ field: "software" }, { data: json });

  assert.equal(result.length, 2);
  assert.equal(result[0].name, "A");
  assert.equal(result[0].field, "software"); // inherited from jobSpec
  assert.equal(result[0].source, "upload");
  assert.equal(result[1].field, "engineering"); // p.field overrides jobSpec field
  assert.deepEqual(result[1].skills, ["z"]);
});

test("upload.search: parses a single JSON object (non-array) as one candidate", async () => {
  const json = JSON.stringify({ name: "Solo" });
  const result = await uploadProvider.search({ field: "design" }, { data: json });
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "Solo");
});

test("upload.search: blank/absent data returns []", async () => {
  assert.deepEqual(await uploadProvider.search({ field: "software" }, { data: "" }), []);
  assert.deepEqual(await uploadProvider.search({ field: "software" }, {}), []);
  assert.deepEqual(await uploadProvider.search({ field: "software" }), []);
});

// ---------------------------------------------------------------------------
// sample provider
// ---------------------------------------------------------------------------

test("sample.search: field='healthcare' loads data/samples/nursing.json (alias) and normalizes it", async () => {
  const nursingRaw = JSON.parse(readFileSync(path.join(SAMPLES_DIR, "nursing.json"), "utf8"));
  const result = await sampleProvider.search({ field: "healthcare" });

  assert.equal(result.length, nursingRaw.length);
  assert.ok(result.length > 0);
  assert.equal(result[0].source, "sample");
  assert.equal(result[0].field, "healthcare");
  assert.equal(result[0].name, nursingRaw[0].name);
});

test("sample.search: field with no matching sample file returns []", async () => {
  const result = await sampleProvider.search({ field: "underwater-basket-weaving" });
  assert.deepEqual(result, []);
});

test("sample.search: missing/blank field returns []", async () => {
  assert.deepEqual(await sampleProvider.search({}), []);
  assert.deepEqual(await sampleProvider.search({ field: "" }), []);
});

test("sample.search: a non-aliased field (e.g. 'software') loads software.json directly", async () => {
  const softwareRaw = JSON.parse(readFileSync(path.join(SAMPLES_DIR, "software.json"), "utf8"));
  const result = await sampleProvider.search({ field: "software" });
  assert.equal(result.length, softwareRaw.length);
  assert.equal(result[0].field, "software");
});
