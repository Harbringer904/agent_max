import crypto from "crypto";
import { agentSearch } from "./orchestrate.js";

export const MAX_JOBS = 100;
export const TTL_MS = 10 * 60 * 1000;

const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const _jobs = new Map();

function nowIso() {
  return new Date().toISOString();
}

function sweepExpired() {
  const cutoff = Date.now() - TTL_MS;
  for (const [jobId, job] of _jobs) {
    if (Date.parse(job.updatedAt) < cutoff) {
      _jobs.delete(jobId);
    }
  }
}

function evictIfNeeded() {
  while (_jobs.size >= MAX_JOBS) {
    const oldestKey = _jobs.keys().next().value;
    if (oldestKey === undefined) break;
    _jobs.delete(oldestKey);
  }
}

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
      }
    },
  };

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
