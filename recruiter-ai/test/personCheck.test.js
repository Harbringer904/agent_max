// test/personCheck.test.js
//
// lib/personCheck.js — is this "candidate" an individual, or an organization?
// See docs/DATA_QUALITY_PLAN.md P3.

import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeOrganization, personPartOf } from "../lib/personCheck.js";

test("rejects organizations, conferences, datasets", () => {
  for (const n of [
    "BAJAJ CAPITAL INVESTMENT ADVISERS PRIVATE LIMITED",
    "Hum Fauji Financial Services Pvt Ltd",
    "CYPHER Workshop on Machine Learning for Complex Flows",
    "UCI Machine Learning Repository",
    "Institute for Machine Learning",
    "Subcommittee on Machine Learning & Artificial Intelligence",
  ]) {
    assert.equal(looksLikeOrganization(n), true, `should reject: ${n}`);
  }
});

test("accepts ordinary personal names", () => {
  for (const n of ["ABHISHEK KUMAR", "Witold Pedrycz", "Mary Claire Abbot", "Jinde Cao"]) {
    assert.equal(looksLikeOrganization(n), false, `should accept: ${n}`);
  }
});

// Regression: found live via `npm run doctor`. The org-token rule was dropping
// REAL sole-proprietor advisers from the SEBI registry because their registered
// name appends the firm. A sole proprietorship is legally a natural person.
test("accepts sole proprietors whose registry name appends a firm", () => {
  assert.equal(looksLikeOrganization("Abhishek Phore - Proprietor Control Wealth Advisers"), false);
  assert.equal(looksLikeOrganization("KUSHAL BHATEJA PROPRIETOR OF FINCLIN INVESTMENT ADVISORS"), false);
});

test("a proprietor marker with no personal name in front is NOT a person", () => {
  assert.equal(looksLikeOrganization("Proprietor of Some Firm"), true);
});

test("personPartOf extracts the human part, or returns input unchanged", () => {
  assert.equal(personPartOf("Abhishek Phore - Proprietor Control Wealth Advisers"), "Abhishek Phore");
  assert.equal(personPartOf("KUSHAL BHATEJA PROPRIETOR OF FINCLIN"), "KUSHAL BHATEJA");
  assert.equal(personPartOf("ABHISHEK KUMAR"), "ABHISHEK KUMAR");
});

test("blank/missing names are rejected rather than passed through", () => {
  assert.equal(looksLikeOrganization(""), true);
  assert.equal(looksLikeOrganization(null), true);
  assert.equal(looksLikeOrganization(undefined), true);
});
