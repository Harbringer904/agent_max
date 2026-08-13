// routes/search.js
//
// POST /api/search { jobSpec, provider, options } -> { totalFound, candidates:Scored[], matched, scoredBy }
// options.useLLM === true routes through rankCandidatesLLM (falls back to rules internally
// on any failure); scoredBy reflects the ACTUAL scorer used, taken from the candidates.
//
// A criterion may carry an optional boolean `required`. After ranking (rules or LLM — both
// return criteriaScores with a numeric raw), candidates that don't fully meet (raw >= 1 - 1e-9)
// EVERY required criterion are dropped. `totalFound` stays the provider result count; `matched`
// is the post-filter candidate count.
//
// Request body is validated before touching any provider/scoring logic; violations
// respond 400 with an opaque coded error. See docs/ERROR_CODES.md for the code meanings.

import { Router } from "express";
import { getProvider, listProviders } from "../lib/providers/index.js";
import { rankCandidates } from "../lib/scoring/rules.js";
import { rankCandidatesLLM } from "../lib/scoring/llm.js";

const router = Router();

function sendError(res, status, message, code) {
  res.status(status).json({ error: `${message} (${code})` });
}

function isValidCriterion(c) {
  return (
    c &&
    typeof c === "object" &&
    typeof c.key === "string" &&
    c.key.trim().length > 0 &&
    typeof c.weight === "number" &&
    Number.isFinite(c.weight)
  );
}

function isValidJobSpec(jobSpec) {
  return (
    jobSpec &&
    typeof jobSpec === "object" &&
    !Array.isArray(jobSpec) &&
    typeof jobSpec.field === "string" &&
    jobSpec.field.trim().length > 0 &&
    Array.isArray(jobSpec.criteria) &&
    jobSpec.criteria.length > 0 &&
    jobSpec.criteria.every(isValidCriterion)
  );
}

router.post("/", async (req, res) => {
  try {
    const { jobSpec, provider: providerKey, options } = req.body || {};

    if (!isValidJobSpec(jobSpec)) {
      return sendError(res, 400, "Invalid job spec", "R001");
    }

    const knownProviderKeys = listProviders().map((p) => p.key);
    if (typeof providerKey !== "string" || !knownProviderKeys.includes(providerKey)) {
      return sendError(res, 400, "Unknown provider", "R002");
    }

    const provider = getProvider(providerKey);

    const candidates = await provider.search(jobSpec, options || {});
    const ranked = options?.useLLM === true
      ? await rankCandidatesLLM(candidates, jobSpec, 25)
      : rankCandidates(candidates, jobSpec, 25);
    const scoredBy = ranked.some((c) => c.scoredBy === "llm") ? "llm" : "rules";

    const requiredKeys = jobSpec.criteria.filter((c) => c.required === true).map((c) => c.key);
    const filtered = requiredKeys.length
      ? ranked.filter((c) => requiredKeys.every((key) => (c.criteriaScores?.[key]?.raw ?? 0) >= 1 - 1e-9))
      : ranked;

    res.json({
      totalFound: Array.isArray(candidates) ? candidates.length : 0,
      candidates: filtered,
      matched: filtered.length,
      scoredBy,
    });
  } catch (err) {
    console.error("Search error:", err);
    sendError(res, 500, "Internal server error", "R500");
  }
});

export default router;
