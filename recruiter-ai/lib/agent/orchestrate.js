// lib/agent/orchestrate.js
//
// PLAN_V2 §4 P4 — the autonomous orchestration core. Given only a jobSpec,
// decide sources (lib/agent/plan.js), fan them out in parallel with bounded
// latency, merge+dedupe (lib/agent/dedupe.js), score ONCE with the existing
// unchanged scoring engines (lib/scoring/rules.js or lib/scoring/llm.js),
// consolidate into one comparable ranked list (lib/agent/consolidate.js),
// apply the `required` hard filter exactly as routes/search.js does, and
// trim to a ceiling of N.
//
// LATENCY CONTRACT (PLAN_V2 §4 P4):
//   - Per-source timeout guard: SOURCE_TIMEOUT_MS (20s), via Promise.race
//     against a timer, since not all providers have internal timeouts. A
//     source that rejects, times out, or throws contributes ZERO candidates
//     and is recorded in `sourcesQueried` — it NEVER fails the whole search.
//   - Global deadline: GLOBAL_DEADLINE_MS (60s) across the whole fan-out.
//     Implemented by racing Promise.allSettled(perSourcePromises) against a
//     deadline timer; each per-source promise writes its outcome into a
//     shared results Map as soon as IT finishes (not when all finish), so if
//     the deadline wins the race, whatever is already in the Map is used —
//     "whatever has returned by then is what gets scored", per the plan.
//     Per-source promises are already capped at 20s each and never throw
//     uncaught, so letting a straggler keep running in the background after
//     the deadline is harmless (its result is simply never read).
//   - open_web budget: a shrunk budget ({ maxTurns: 3 }) is threaded into
//     open_web's options so one slow agentic source can't dominate the 60s
//     global deadline. As of PLAN_V2.md §5 Phase 3, lib/providers/openWeb.js
//     actually reads and clamps this via resolveBudget() and honors it as
//     the real loop bound (verified live: maxTurns genuinely changes turn
//     count / elapsed time / results) — this is no longer a no-op.
//   - Scoring happens ONCE on the merged+deduped list (BIG topN so nothing
//     is truncated before consolidation) — fan-out never multiplies LLM
//     calls, since rankCandidatesLLM already batches the whole list into one
//     request.
//   - N (topN) is a ceiling, never a promise: real people only, no padding.
//
// agentSearch() NEVER throws — every stage is defensive so a bug in one
// source, or in dedupe/consolidate, degrades the report rather than crashing
// the route.
//
// Exports:
//   agentSearch(jobSpec, options = {}) -> {
//     candidates, totalFound, matched, scoredBy, sourcePlan, agentLog,
//     sourcesQueried: [{ key, count, ms, status }]
//   }

import { getProvider } from "../providers/index.js";
import { rankCandidates } from "../scoring/rules.js";
import { rankCandidatesLLM } from "../scoring/llm.js";
import { selectSources } from "./plan.js";
import { dedupeCandidates } from "./dedupe.js";
import { consolidate } from "./consolidate.js";

const SOURCE_TIMEOUT_MS = 20_000;
const GLOBAL_DEADLINE_MS = 60_000;
const SCORE_BATCH_SIZE = 200; // large enough not to truncate before consolidation
const DEFAULT_TOP_N = 10;
const MIN_TOP_N = 1;
const MAX_TOP_N = 50;

const TIMEOUT_MESSAGE = "source timeout";

function clampTopN(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return DEFAULT_TOP_N;
  return Math.min(MAX_TOP_N, Math.max(MIN_TOP_N, Math.round(num)));
}

/** Race a promise against a timer; rejects with TIMEOUT_MESSAGE on expiry.
 * Always clears the timer so the process doesn't hang open on a fast source. */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(TIMEOUT_MESSAGE)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

/** Build the options object passed to an individual provider's search().
 * open_web gets a shrunk-budget hint added (real as of Phase 3 — see module
 * doc comment above); every other source gets the caller's options as-is. */
function searchOptionsFor(providerKey, options) {
  if (providerKey === "open_web") {
    return { ...options, maxTurns: 3 };
  }
  return options;
}

/**
 * Fan out search() across every planned source. Returns a Map keyed by
 * providerKey -> { candidates, ms, status, error? }. Never throws: every
 * per-source failure (unknown key, provider exception, timeout) is caught
 * and recorded as a zero-candidate outcome.
 */
async function fanOut(sourcePlan, jobSpec, options) {
  const results = new Map();

  const perSourcePromises = sourcePlan.map(async (entry) => {
    const providerKey = entry.providerKey;
    const start = Date.now();
    try {
      const provider = getProvider(providerKey);
      const searchOptions = searchOptionsFor(providerKey, options);
      const raw = await withTimeout(provider.search(jobSpec, searchOptions), SOURCE_TIMEOUT_MS);
      const candidates = Array.isArray(raw) ? raw : [];
      results.set(providerKey, {
        candidates,
        ms: Date.now() - start,
        status: "ok",
      });
    } catch (err) {
      const isTimeout = err && err.message === TIMEOUT_MESSAGE;
      results.set(providerKey, {
        candidates: [],
        ms: Date.now() - start,
        status: isTimeout ? "timeout" : "error",
        error: err && err.message ? err.message : String(err),
      });
    }
  });

  // Race the WHOLE fan-out against the global deadline. Each per-source
  // promise above already wrote its own outcome into `results` by the time
  // it settles (success or caught failure) — so if the deadline timer wins
  // this race, `results` simply holds whatever finished so far, and any
  // still-pending source is left out of scoring (per PLAN_V2 §4 P4).
  await Promise.race([
    Promise.allSettled(perSourcePromises),
    new Promise((resolve) => setTimeout(resolve, GLOBAL_DEADLINE_MS)),
  ]);

  return results;
}

/** Apply the `required` hard filter exactly as routes/search.js does: for
 * every criterion with required===true, drop candidates whose
 * criteriaScores[key].raw < 1 - 1e-9 (float-safe "must equal 1.0"). */
function applyRequiredFilter(scored, jobSpec) {
  const requiredKeys = (Array.isArray(jobSpec?.criteria) ? jobSpec.criteria : [])
    .filter((c) => c && c.required === true)
    .map((c) => c.key);
  if (requiredKeys.length === 0) return scored;
  return scored.filter((c) =>
    requiredKeys.every((key) => (c.criteriaScores?.[key]?.raw ?? 0) >= 1 - 1e-9)
  );
}

function buildSourcesQueried(sourcePlan, results) {
  return sourcePlan.map((entry) => {
    const r = results.get(entry.providerKey);
    if (!r) {
      // Never settled before the global deadline won the race.
      return { key: entry.providerKey, count: 0, ms: GLOBAL_DEADLINE_MS, status: "timeout" };
    }
    return {
      key: entry.providerKey,
      count: Array.isArray(r.candidates) ? r.candidates.length : 0,
      ms: r.ms,
      status: r.status,
    };
  });
}

/**
 * Run the full autonomous pipeline for one jobSpec: select sources, fan out,
 * dedupe, score once, consolidate, apply required filters, trim to topN.
 * Never throws — degrades to an empty/partial report on any internal failure.
 *
 * @param {object} jobSpec
 * @param {object} [options] - { data?: string, useLLM?: boolean }, forwarded
 *   to selectSources() and to every provider's search()
 * @returns {Promise<object>}
 */
export async function agentSearch(jobSpec, options = {}) {
  const agentLog = [];
  const topN = clampTopN(options?.topN);

  try {
    const { sourcePlan, log: planLog } = await selectSources(jobSpec, options);
    agentLog.push(...planLog);

    if (sourcePlan.length === 0) {
      agentLog.push("agentSearch: no sources selected, returning empty report");
      return {
        candidates: [],
        totalFound: 0,
        matched: 0,
        scoredBy: "rules",
        sourcePlan,
        agentLog: agentLog.join("\n"),
        sourcesQueried: [],
      };
    }

    const results = await fanOut(sourcePlan, jobSpec, options);
    const sourcesQueried = buildSourcesQueried(sourcePlan, results);
    for (const sq of sourcesQueried) {
      agentLog.push(`source ${sq.key}: ${sq.status}, ${sq.count} candidate(s), ${sq.ms}ms`);
    }

    const merged = sourcePlan.flatMap((entry) => results.get(entry.providerKey)?.candidates || []);
    const totalFound = merged.length;

    const { candidates: deduped, log: dedupeLog } = dedupeCandidates(merged);
    agentLog.push(...dedupeLog);

    const scored = options?.useLLM === true
      ? await rankCandidatesLLM(deduped, jobSpec, SCORE_BATCH_SIZE)
      : rankCandidates(deduped, jobSpec, SCORE_BATCH_SIZE);
    const scoredBy = scored.some((c) => c.scoredBy === "llm") ? "llm" : "rules";

    const consolidated = consolidate(scored, jobSpec);
    const filtered = applyRequiredFilter(consolidated, jobSpec);
    const trimmed = filtered.slice(0, topN);

    agentLog.push(
      `agentSearch: ${totalFound} found -> ${deduped.length} after dedupe -> ${filtered.length} after required filter -> ${trimmed.length} returned (topN=${topN})`
    );

    return {
      candidates: trimmed,
      totalFound,
      matched: filtered.length,
      scoredBy,
      sourcePlan,
      agentLog: agentLog.join("\n"),
      sourcesQueried,
    };
  } catch (err) {
    agentLog.push(`agentSearch failed unexpectedly, degrading to empty report: ${err && err.message ? err.message : String(err)}`);
    return {
      candidates: [],
      totalFound: 0,
      matched: 0,
      scoredBy: "rules",
      sourcePlan: [],
      agentLog: agentLog.join("\n"),
      sourcesQueried: [],
    };
  }
}
