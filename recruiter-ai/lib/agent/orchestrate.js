import { getProvider } from "../providers/index.js";
import { rankCandidates } from "../scoring/rules.js";
import { rankCandidatesLLM } from "../scoring/llm.js";
import { selectSources } from "./plan.js";
import { dedupeCandidates } from "./dedupe.js";
import { consolidate } from "./consolidate.js";
import { traitsFor } from "../providers/traits.js";
import { looksLikeOrganization } from "../personCheck.js";

const SOURCE_TIMEOUT_MS = 20_000;
const GLOBAL_DEADLINE_MS = 60_000;
const SCORE_BATCH_SIZE = 200;
const DEFAULT_TOP_N = 10;
const MIN_TOP_N = 1;
const MAX_TOP_N = 50;

const TIMEOUT_MESSAGE = "source timeout";

function clampTopN(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return DEFAULT_TOP_N;
  return Math.min(MAX_TOP_N, Math.max(MIN_TOP_N, Math.round(num)));
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(TIMEOUT_MESSAGE)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function searchOptionsFor(providerKey, options) {
  if (providerKey === "open_web") {
    return { ...options, maxTurns: 3 };
  }
  return options;
}

function emitProgress(onProgress, update) {
  if (typeof onProgress !== "function") return;
  try {
    onProgress(update);
  } catch {
  }
}

async function fanOut(sourcePlan, jobSpec, options, onProgress) {
  const results = new Map();
  const sourcesTotal = sourcePlan.length;
  let sourcesDone = 0;

  const perSourcePromises = sourcePlan.map(async (entry) => {
    const providerKey = entry.providerKey;
    const start = Date.now();
    let outcome;
    try {
      const provider = getProvider(providerKey);
      const searchOptions = searchOptionsFor(providerKey, options);
      const raw = await withTimeout(provider.search(jobSpec, searchOptions), SOURCE_TIMEOUT_MS);
      const candidates = Array.isArray(raw) ? raw : [];
      outcome = { candidates, ms: Date.now() - start, status: "ok" };
    } catch (err) {
      const isTimeout = err && err.message === TIMEOUT_MESSAGE;
      outcome = {
        candidates: [],
        ms: Date.now() - start,
        status: isTimeout ? "timeout" : "error",
        error: err && err.message ? err.message : String(err),
      };
    }
    results.set(providerKey, outcome);
    sourcesDone += 1;
    emitProgress(onProgress, {
      phase: "sourcing",
      sourcesTotal,
      sourcesDone,
      sourceResult: { key: providerKey, count: outcome.candidates.length, ms: outcome.ms, status: outcome.status },
      logLine: `source ${providerKey}: ${outcome.status}, ${outcome.candidates.length} candidate(s), ${outcome.ms}ms`,
    });
  });

  await Promise.race([
    Promise.allSettled(perSourcePromises),
    new Promise((resolve) => setTimeout(resolve, GLOBAL_DEADLINE_MS)),
  ]);

  return results;
}

function applyRequiredFilter(scored, jobSpec) {
  const requiredKeys = (Array.isArray(jobSpec?.criteria) ? jobSpec.criteria : [])
    .filter((c) => c && c.required === true)
    .map((c) => c.key);
  if (requiredKeys.length === 0) return scored;
  return scored.filter((c) =>
    requiredKeys.every((key) => (c.criteriaScores?.[key]?.raw ?? 0) >= 1 - 1e-9)
  );
}

function dropNonPersonRows(candidates, agentLog) {
  const droppedBySource = new Map();
  const kept = candidates.filter((c) => {
    const traits = traitsFor(c.source);
    if (traits.entityType !== "person" || traits.nameIsHandle === true) return true;
    if (!looksLikeOrganization(c.name)) return true;
    droppedBySource.set(c.source, (droppedBySource.get(c.source) || 0) + 1);
    return false;
  });
  for (const [source, count] of droppedBySource) {
    agentLog.push(`dropped ${count} non-person row(s) from ${source}`);
  }
  return kept;
}

function buildSourcesQueried(sourcePlan, results) {
  return sourcePlan.map((entry) => {
    const r = results.get(entry.providerKey);
    if (!r) {
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
  const onProgress = options?.onProgress;

  try {
    const { sourcePlan, log: planLog } = await selectSources(jobSpec, options);
    agentLog.push(...planLog);

    if (sourcePlan.length === 0) {
      agentLog.push("agentSearch: no sources selected, returning empty report");
      emitProgress(onProgress, {
        phase: "sourcing",
        sourcesTotal: 0,
        sourcesDone: 0,
        sourcePlan,
        logLine: "agentSearch: no sources selected, returning empty report",
      });
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

    emitProgress(onProgress, { phase: "planning", sourcesTotal: sourcePlan.length, sourcesDone: 0, sourcePlan });

    const results = await fanOut(sourcePlan, jobSpec, options, onProgress);
    const sourcesQueried = buildSourcesQueried(sourcePlan, results);
    for (const sq of sourcesQueried) {
      agentLog.push(`source ${sq.key}: ${sq.status}, ${sq.count} candidate(s), ${sq.ms}ms`);
    }

    const merged = sourcePlan.flatMap((entry) => results.get(entry.providerKey)?.candidates || []);
    const totalFound = merged.length;

    const personFiltered = dropNonPersonRows(merged, agentLog);

    const { candidates: deduped, log: dedupeLog } = dedupeCandidates(personFiltered);
    agentLog.push(...dedupeLog);

    emitProgress(onProgress, {
      phase: "scoring",
      sourcesTotal: sourcePlan.length,
      sourcesDone: results.size,
      logLine: `agentSearch: scoring ${deduped.length} candidate(s) after dedupe`,
    });

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
