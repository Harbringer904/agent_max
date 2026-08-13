// test/resultsStore.test.js
//
// Unit tests for lib/resultsStore.js — asserts REAL current behavior.
// Cleans up every file it creates under data/results/.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { saveResult, getResult } from "../lib/resultsStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, "..", "data", "results");

function cleanup(id) {
  const filePath = path.join(RESULTS_DIR, `${id}.json`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

test("saveResult then getResult round-trips the payload", () => {
  const jobSpec = { field: "software", title: "Backend Engineer", criteria: [] };
  const candidates = [{ id: "c1", name: "Jane", totalScore: 88, rank1to10: 9 }];
  const scoredBy = "rules";

  const id = saveResult({ jobSpec, candidates, scoredBy });
  try {
    assert.match(id, /^[A-Za-z0-9_-]{1,64}$/);

    const payload = getResult(id);
    assert.ok(payload);
    assert.equal(payload.id, id);
    assert.deepEqual(payload.jobSpec, jobSpec);
    assert.deepEqual(payload.candidates, candidates);
    assert.equal(payload.scoredBy, scoredBy);
    assert.equal(typeof payload.createdAt, "string");
    assert.ok(!Number.isNaN(Date.parse(payload.createdAt)));
  } finally {
    cleanup(id);
  }
});

test("saveResult generates a distinct id on each call", () => {
  const id1 = saveResult({ jobSpec: {}, candidates: [], scoredBy: "rules" });
  const id2 = saveResult({ jobSpec: {}, candidates: [], scoredBy: "rules" });
  try {
    assert.notEqual(id1, id2);
  } finally {
    cleanup(id1);
    cleanup(id2);
  }
});

test("getResult: path traversal ids are rejected and return null", () => {
  assert.equal(getResult("../../etc/passwd"), null);
  assert.equal(getResult("../resultsStore.js"), null);
  assert.equal(getResult("a/b"), null);
  assert.equal(getResult("a\\b"), null);
});

test("getResult: non-string / empty ids return null", () => {
  assert.equal(getResult(""), null);
  assert.equal(getResult(null), null);
  assert.equal(getResult(undefined), null);
  assert.equal(getResult(123), null);
});

test("getResult: well-formed but nonexistent id returns null", () => {
  assert.equal(getResult("does-not-exist-00000000"), null);
});
