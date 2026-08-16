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
