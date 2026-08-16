// lib/agent/jobs.js
//
// PLAN_V2 §5 Phase 5 — in-memory job registry backing async agent-search
// polling. No new deps, no database: jobs live in a Map for the life of the
// process. Converts the blocking agentSearch() call into
// createJob() (returns immediately) + getJob() (poll for progress/result).
//
// Job shape (FROZEN — routes/agentJobs.js and the frontend build against
// exactly this):
//   { jobId, status: "running" | "done" | "error",
//     startedAt, updatedAt,
//     progress: { phase: string, sourcesTotal: number, sourcesDone: number },
//     sourcePlan: [{ providerKey, reason }] | null,
//     sourcesQueried: [{ key, count, ms, status }],
//     agentLog: string,
//     result: <full agentSearch response> | null,
//     error: string | null }
//
// Resilience:
//   - A run that throws lands the job in status "error" with a message —
//     it never crashes the process (the runner promise's .catch always
//     resolves the job, never rejects).
//   - TTL: jobs untouched (no status/progress update) for TTL_MS are dropped
//     on the next sweep. Swept lazily on createJob() — no background timer,
//     so nothing keeps the process alive or complicates tests.
//   - Cap: MAX_JOBS jobs max; creating a new job past the cap evicts the
//     oldest (by creation order, which a Map's insertion order gives us for
//     free since jobs are never re-inserted on update).
//
// Exports:
//   createJob(jobSpec, options, runner = agentSearch) -> jobId
//   getJob(jobId) -> job snapshot | null
//   MAX_JOBS, TTL_MS — exported for tests
//   _jobs — the live Map, exported ONLY so tests can manipulate timestamps
//           to exercise TTL/eviction without sleeping. Not for production use.

import crypto from "crypto";
import { agentSearch } from "./orchestrate.js";

export const MAX_JOBS = 100;
export const TTL_MS = 10 * 60 * 1000; // 10 minutes

const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Live job store. Insertion order == creation order (Map contract), which is
// exactly what oldest-first eviction needs; jobs are only ever mutated in
// place, never deleted-and-reinserted, so that ordering stays valid.
export const _jobs = new Map();

function nowIso() {
  return new Date().toISOString();
}

/** Drop jobs whose updatedAt is older than TTL_MS. Lazy — runs on every
 * createJob() call so memory can't grow unbounded without needing a timer. */
function sweepExpired() {
  const cutoff = Date.now() - TTL_MS;
  for (const [jobId, job] of _jobs) {
    if (Date.parse(job.updatedAt) < cutoff) {
      _jobs.delete(jobId);
    }
  }
}

/** Evict the oldest job(s) if adding one more would exceed MAX_JOBS. */
function evictIfNeeded() {
  while (_jobs.size >= MAX_JOBS) {
    const oldestKey = _jobs.keys().next().value;
    if (oldestKey === undefined) break;
    _jobs.delete(oldestKey);
  }
}

/** Merge a progress update from agentSearch's onProgress callback into the
 * live job. Defensive against malformed/partial updates. */
function applyProgress(job, update) {
  if (!update || typeof update !== "object") return;

  if (typeof update.phase === "string") job.progress.phase = update.phase;
  if (typeof update.sourcesTotal === "number") job.progress.sourcesTotal = update.sourcesTotal;
  if (typeof update.sourcesDone === "number") job.progress.sourcesDone = update.sourcesDone;
  if (Array.isArray(update.sourcePlan)) job.sourcePlan = update.sourcePlan;
  if (update.sourceResult && typeof update.sourceResult === "object") {
    job.sourcesQueried.push(update.sourceResult);
  }
  if (typeof update.logLine === "string" && update.logLine.length > 0) {
    job.agentLog = job.agentLog ? `${job.agentLog}\n${update.logLine}` : update.logLine;
  }

  job.updatedAt = nowIso();
}

/**
 * Start a job in the background and return its id immediately. The actual
 * search runs asynchronously; poll getJob(jobId) for progress/result.
 *
 * @param {object} jobSpec
 * @param {object} [options] - forwarded to the runner (e.g. { topN, useLLM,
 *   data }); any caller-supplied onProgress is ignored — the registry
 *   installs its own so it can update the job snapshot.
 * @param {Function} [runner] - defaults to agentSearch; injectable for tests
 *   so they never hit the real network.
 * @returns {string} jobId
 */
export function createJob(jobSpec, options = {}, runner = agentSearch) {
  sweepExpired();
  evictIfNeeded();

  const jobId = crypto.randomUUID();
  const startedAt = nowIso();

  const job = {
    jobId,
    status: "running",
    startedAt,
    updatedAt: startedAt,
    progress: { phase: "planning", sourcesTotal: 0, sourcesDone: 0 },
    sourcePlan: null,
    sourcesQueried: [],
    agentLog: "",
    result: null,
    error: null,
  };
  _jobs.set(jobId, job);

  const runnerOptions = {
    ...options,
    onProgress: (update) => {
      try {
        applyProgress(job, update);
      } catch {
        // a malformed progress update must never break the run
      }
    },
  };

  // Fire-and-forget: never awaited, never allowed to reject uncaught. Both
  // branches always resolve the job, so this can't produce an unhandled
  // rejection even if `runner` itself throws synchronously (Promise.resolve
  // wraps that too).
  Promise.resolve()
    .then(() => runner(jobSpec, runnerOptions))
    .then((result) => {
      job.status = "done";
      job.result = result;
      if (result && typeof result === "object") {
        if (Array.isArray(result.sourcePlan)) job.sourcePlan = result.sourcePlan;
        if (Array.isArray(result.sourcesQueried)) job.sourcesQueried = result.sourcesQueried;
        if (typeof result.agentLog === "string") job.agentLog = result.agentLog;
      }
      job.progress = {
        phase: "done",
        sourcesTotal: job.progress.sourcesTotal,
        sourcesDone: job.progress.sourcesTotal,
      };
      job.updatedAt = nowIso();
    })
    .catch((err) => {
      job.status = "error";
      job.error = err && err.message ? err.message : String(err);
      job.updatedAt = nowIso();
    });

  return jobId;
}

/** Strict jobId validation before any lookup — same defensive posture as
 * lib/resultsStore.js's id check. */
export function isValidJobId(jobId) {
  return typeof jobId === "string" && JOB_ID_PATTERN.test(jobId);
}

/**
 * Fetch a snapshot of a job's current state. Returns a shallow copy so
 * callers can never mutate the live registry through the returned object.
 *
 * @param {string} jobId
 * @returns {object|null}
 */
export function getJob(jobId) {
  if (!isValidJobId(jobId)) return null;

  const job = _jobs.get(jobId);
  if (!job) return null;

  return {
    jobId: job.jobId,
    status: job.status,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    progress: { ...job.progress },
    sourcePlan: job.sourcePlan ? job.sourcePlan.map((e) => ({ ...e })) : null,
    sourcesQueried: job.sourcesQueried.map((s) => ({ ...s })),
    agentLog: job.agentLog,
    result: job.result,
    error: job.error,
  };
}
