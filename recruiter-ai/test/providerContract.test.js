// test/providerContract.test.js
//
// Offline contract tests against CAPTURED REAL provider output
// (test/fixtures/<providerKey>.json, written by scripts/capture-fixtures.mjs).
//
// WHY THIS EXISTS (docs/DATA_QUALITY_PLAN.md P1):
// The three shipped bugs all had green tests because every fixture was
// IMAGINED by whoever wrote the test, and an imagined fixture encodes the
// author's assumptions — exactly the assumptions that turned out to be
// false. These tests run the same invariants scripts/doctor.mjs checks
// live, but OFFLINE against real captured responses, so CI needs no network
// and no API keys while still defending against real-world shapes.
//
// No network calls happen here. If a fixture file is missing (fresh clone,
// or a provider was rate-limited/keyless at capture time), that provider's
// checks are SKIPPED, not failed — but logged clearly so the gap is visible
// rather than silent. Run `npm run capture-fixtures` to fill gaps.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

import { listProviders } from "../lib/providers/index.js";
import { traitsFor } from "../lib/providers/traits.js";
import { looksLikeOrganization } from "../lib/personCheck.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");

function loadFixture(key) {
  const p = path.join(FIXTURES_DIR, `${key}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

/** Same identity-bearing URL normalization as lib/agent/dedupe.js /
 * scripts/doctor.mjs — only a noise-param denylist is stripped, so a query
 * string that actually distinguishes records (e.g. hn_hiring's ?id=<commentId>)
 * still counts as a different URL. */
const NOISE = /^(utm_|fbclid$|gclid$|ref$|referrer$|source$|tab$|sort$|order$|page$|view$|filter$|lang$|locale$|hl$)/i;
function normUrl(u) {
  if (!u) return "";
  let s = String(u).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("#")[0];
  const q = s.indexOf("?");
  let path_ = (q >= 0 ? s.slice(0, q) : s).replace(/\/+$/, "");
  if (q < 0) return path_;
  const kept = s.slice(q + 1).split("&").filter((kv) => kv && !NOISE.test(kv.split("=")[0])).sort();
  return kept.length ? path_ + "?" + kept.join("&") : path_;
}

const providerKeys = listProviders()
  .map((p) => p.key)
  .filter((k) => k !== "upload"); // needs caller-supplied data, never has a captured fixture

const withFixture = [];
const withoutFixture = [];
for (const key of providerKeys) {
  (loadFixture(key) ? withFixture : withoutFixture).push(key);
}

// Make the coverage gap impossible to miss in test output, per the plan's
// "skip gracefully but log clearly" requirement.
test("fixture coverage report", () => {
  console.log(`\n  providerContract: ${withFixture.length}/${providerKeys.length} providers have a captured fixture.`);
  if (withoutFixture.length) {
    console.log(`  providerContract: NO FIXTURE (checks skipped) for: ${withoutFixture.join(", ")}`);
    console.log(`  providerContract: run "npm run capture-fixtures" to fill gaps when quota/keys are available.\n`);
  }
  assert.ok(true);
});

// Sanity: every fixture file that actually exists on disk maps to a
// registered provider key — an orphaned fixture usually means a provider
// was renamed/removed and the old capture was never cleaned up.
test("every captured fixture file corresponds to a registered provider", () => {
  if (!existsSync(FIXTURES_DIR)) return;
  const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    const key = f.replace(/\.json$/, "");
    assert.ok(providerKeys.includes(key), `test/fixtures/${f} does not match any registered provider key`);
  }
});

for (const key of providerKeys) {
  const fixture = loadFixture(key);

  test(`[${key}] captured fixture: valid Candidate shape`, (t) => {
    if (!fixture) {
      t.skip(`no captured fixture for "${key}" — run npm run capture-fixtures`);
      return;
    }
    assert.ok(Array.isArray(fixture), `${key} fixture must be an array`);
    assert.ok(fixture.length > 0, `${key} fixture must be non-empty (capture-fixtures.mjs never writes empty fixtures)`);

    for (const c of fixture) {
      assert.equal(typeof c.name, "string", `${key}: name must be a string`);
      assert.ok(c.name.trim().length > 0, `${key}: name must be non-empty (candidate id ${c.id})`);

      assert.equal(c.source, key, `${key}: source must equal provider key, got "${c.source}"`);

      if (c.sourceUrl != null) {
        assert.equal(typeof c.sourceUrl, "string", `${key}: sourceUrl must be a string or null`);
        assert.match(c.sourceUrl, /^https?:\/\//i, `${key}: sourceUrl "${c.sourceUrl}" is not a real http(s) URL`);
      }

      // Real past defect class: yearsExperience arriving as a date string
      // (e.g. "2018-04-01") instead of a number of years. Must be numeric or null.
      if (c.yearsExperience != null) {
        assert.equal(typeof c.yearsExperience, "number", `${key}: yearsExperience must be numeric-or-null, got ${JSON.stringify(c.yearsExperience)}`);
        assert.ok(Number.isFinite(c.yearsExperience), `${key}: yearsExperience must be finite`);
      }

      assert.ok(Array.isArray(c.skills), `${key}: skills must be an array`);
      assert.ok(Array.isArray(c.certifications), `${key}: certifications must be an array`);
    }
  });

  test(`[${key}] captured fixture: sourceUrlIdentifiesPerson traits contract`, (t) => {
    if (!fixture) {
      t.skip(`no captured fixture for "${key}" — run npm run capture-fixtures`);
      return;
    }
    const traits = traitsFor(key);
    // THIS is the assertion that would have caught Bug 1 (SEBI/NMC dedupe
    // collapse) before it shipped: a provider that DECLARES its sourceUrl
    // identifies an individual person must actually deliver distinct URLs
    // per candidate in real data. If it doesn't, either the provider's data
    // has no real per-person permalink (traits are lying) or dedupe.js's
    // url-merge tier will silently collapse unrelated people the moment two
    // of them share a URL — exactly what happened to 25 SEBI advisers.
    if (traits.sourceUrlIdentifiesPerson) {
      const withUrl = fixture.filter((c) => c.sourceUrl);
      if (withUrl.length > 1) {
        const uniqUrls = new Set(withUrl.map((c) => normUrl(c.sourceUrl))).size;
        assert.equal(
          uniqUrls,
          withUrl.length,
          `${key}: declares sourceUrlIdentifiesPerson:true but ${withUrl.length} candidates share only ${uniqUrls} distinct sourceUrl(s) — ` +
            `dedupe.js would wrongly merge distinct people. Either fix the provider's URL, or set sourceUrlIdentifiesPerson:false.`
        );
      }
    }
  });

  test(`[${key}] captured fixture: person-likeness contract`, (t) => {
    if (!fixture) {
      t.skip(`no captured fixture for "${key}" — run npm run capture-fixtures`);
      return;
    }
    const traits = traitsFor(key);
    // THIS is the assertion that would have caught Bug 2 (OpenAlex returning
    // conferences/institutes/datasets as "candidates"): a provider whose
    // traits claim it returns individual people (not org listings, not
    // opaque handles) must actually clear the shared organization-name
    // heuristic on real data, at least most of the time.
    if (traits.entityType === "person" && !traits.nameIsHandle) {
      const personLike = fixture.filter((c) => !looksLikeOrganization(c.name)).length;
      const ratio = personLike / fixture.length;
      assert.ok(
        ratio >= 0.8,
        `${key}: entityType:"person" (and not a handle-based provider) but only ${personLike}/${fixture.length} ` +
          `(${Math.round(ratio * 100)}%) of captured names pass looksLikeOrganization===false — provider may be returning organizations/events, not people.`
      );
    }
  });
}
