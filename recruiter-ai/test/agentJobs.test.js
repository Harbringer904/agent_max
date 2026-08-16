// test/agentJobs.test.js
//
// Unit tests for lib/agent/jobs.js — PLAN_V2 §5 Phase 5 in-memory job
// registry. Every test injects a stub runner (never the real agentSearch),
// so none of this hits the network. _jobs.clear() at the top of each test
// isolates tests from each other since the registry is module-level state.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createJob, getJob, isValidJobId, MAX_JOBS, TTL_MS, _jobs } from "../lib/agent/jobs.js";

const JOB_SPEC = { field: "software", criteria: [{ key: "skills", weight: 1 }] };

function waitFor(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor: timed out"));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function fastRunner(overrides = {}) {
  return async () => ({
    candidates: [],
    totalFound: 0,
    matched: 0,
    scoredBy: "rules",
    sourcePlan: [],
    agentLog: "",
    sourcesQueried: [],
    ...overrides,
  });
}

test("job lifecycle: create -> running -> done, with incremental progress", async () => {
  _jobs.clear();

  const sourcePlan = [
    { providerKey: "github", reason: "test" },
    { providerKey: "stackoverflow", reason: "test" },
  ];

  const runner = async (jobSpec, options) => {
    options.onProgress({ phase: "planning", sourcesTotal: 2, sourcesDone: 0, sourcePlan });
    await new Promise((r) => setTimeout(r, 5));
    options.onProgress({
      phase: "sourcing",
      sourcesTotal: 2,
      sourcesDone: 1,
      sourceResult: { key: "github", count: 3, ms: 5, status: "ok" },
      logLine: "source github: ok, 3 candidate(s), 5ms",
    });
    await new Promise((r) => setTimeout(r, 5));
    options.onProgress({
      phase: "sourcing",
      sourcesTotal: 2,
      sourcesDone: 2,
      sourceResult: { key: "stackoverflow", count: 1, ms: 8, status: "ok" },
      logLine: "source stackoverflow: ok, 1 candidate(s), 8ms",
    });
    return {
      candidates: [{ id: "c1", name: "Jane" }],
      totalFound: 4,
      matched: 1,
      scoredBy: "rules",
      sourcePlan,
      agentLog: "final log",
      sourcesQueried: [
        { key: "github", count: 3, ms: 5, status: "ok" },
        { key: "stackoverflow", count: 1, ms: 8, status: "ok" },
      ],
    };
  };

  const jobId = createJob(JOB_SPEC, {}, runner);

  assert.ok(isValidJobId(jobId));

  // The runner body hasn't executed yet (it's scheduled via Promise.resolve().then()),
  // so the job must still read "running" synchronously right after creation.
  const immediate = getJob(jobId);
  assert.equal(immediate.status, "running");
  assert.equal(immediate.result, null);
  assert.equal(immediate.error, null);

  // Poll and record snapshots to prove sourcesDone increases incrementally
  // (0 -> 1 -> 2) rather than jumping straight from 0 to done.
  const seenSourcesDone = new Set([immediate.progress.sourcesDone]);
  await waitFor(() => {
    const snap = getJob(jobId);
    seenSourcesDone.add(snap.progress.sourcesDone);
    return snap.status !== "running";
  });

  assert.ok(seenSourcesDone.has(1), `expected to observe sourcesDone=1 at some point, saw: ${[...seenSourcesDone]}`);

  const final = getJob(jobId);
  assert.equal(final.status, "done");
  assert.equal(final.error, null);
  assert.deepEqual(final.sourcePlan, sourcePlan);
  assert.equal(final.sourcesQueried.length, 2);
  assert.equal(final.progress.phase, "done");
  assert.equal(final.progress.sourcesDone, final.progress.sourcesTotal);
  assert.deepEqual(final.result.candidates, [{ id: "c1", name: "Jane" }]);
  assert.equal(final.agentLog, "final log");
});

test("getJob: unknown (but well-formed) jobId returns null", () => {
  _jobs.clear();
  const neverCreated = "11111111-1111-4111-8111-111111111111";
  assert.ok(isValidJobId(neverCreated));
  assert.equal(getJob(neverCreated), null);
});

test("getJob / isValidJobId: malformed jobIds are rejected before any lookup", () => {
  _jobs.clear();
  assert.equal(getJob("not-a-uuid"), null);
  assert.equal(getJob("../../etc/passwd"), null);
  assert.equal(getJob(""), null);
  assert.equal(getJob(null), null);
  assert.equal(getJob(undefined), null);
  assert.equal(getJob(123), null);

  assert.equal(isValidJobId("not-a-uuid"), false);
  assert.equal(isValidJobId(null), false);
});

test("an erroring run lands the job in status 'error', never throws or crashes", async () => {
  _jobs.clear();

  const unhandledRejections = [];
  const onUnhandled = (err) => unhandledRejections.push(err);
  process.on("unhandledRejection", onUnhandled);

  try {
    const runner = async () => {
      throw new Error("boom: provider exploded");
    };

    const jobId = createJob(JOB_SPEC, {}, runner);
    await waitFor(() => getJob(jobId).status !== "running");

    const job = getJob(jobId);
    assert.equal(job.status, "error");
    assert.equal(job.error, "boom: provider exploded");
    assert.equal(job.result, null);

    // Give any stray unhandled-rejection microtask a chance to surface.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(unhandledRejections.length, 0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("createJob passes through options (topN etc.) to the runner untouched, plus its own onProgress", async () => {
  _jobs.clear();

  let receivedOptions = null;
  const runner = async (jobSpec, options) => {
    receivedOptions = options;
    return { candidates: [], totalFound: 0, matched: 0, scoredBy: "rules", sourcePlan: [], agentLog: "", sourcesQueried: [] };
  };

  const jobId = createJob(JOB_SPEC, { topN: 5, useLLM: false }, runner);
  await waitFor(() => getJob(jobId).status !== "running");

  assert.equal(receivedOptions.topN, 5);
  assert.equal(receivedOptions.useLLM, false);
  assert.equal(typeof receivedOptions.onProgress, "function");
});

test("TTL: a job untouched for longer than TTL_MS is dropped on the next sweep", async () => {
  _jobs.clear();

  const jobId = createJob(JOB_SPEC, {}, fastRunner());
  await waitFor(() => getJob(jobId).status !== "running");
  assert.ok(getJob(jobId));

  // Simulate the job having gone stale without needing to sleep TTL_MS for real.
  const liveJob = _jobs.get(jobId);
  liveJob.updatedAt = new Date(Date.now() - TTL_MS - 1000).toISOString();

  // sweepExpired() runs lazily inside createJob(), so creating one more job
  // triggers the sweep that should evict the stale one.
  createJob(JOB_SPEC, {}, fastRunner());

  assert.equal(getJob(jobId), null);
  assert.equal(_jobs.has(jobId), false);
});

test("cap: creating more than MAX_JOBS jobs evicts the oldest first", () => {
  _jobs.clear();

  const ids = [];
  for (let i = 0; i < MAX_JOBS + 1; i++) {
    // Runner never resolves within this synchronous loop — eviction happens
    // at creation time, independent of run completion.
    ids.push(createJob(JOB_SPEC, {}, () => new Promise(() => {})));
  }

  assert.ok(_jobs.size <= MAX_JOBS, `expected _jobs.size <= ${MAX_JOBS}, got ${_jobs.size}`);
  assert.equal(getJob(ids[0]), null, "oldest job should have been evicted");
  assert.ok(getJob(ids[ids.length - 1]), "newest job should still be present");
});
