// routes/agentSearch.js
//
// POST /api/agent-search { jobSpec, topN, options } -> { totalFound, matched,
//   candidates:Scored[], scoredBy, sourcePlan, agentLog, sourcesQueried }
//
// The autonomous counterpart to /api/search (routes/search.js, UNTOUCHED by
// this file): the recruiter supplies only a jobSpec (+ optional topN and
// options.data upload / options.useLLM) and lib/agent/orchestrate.js decides
// which sources to query, on its own, per PLAN_V2.md. There is no `provider`
// field in the request body — the whole point of Phase 1 is removing that
// picker from the contract.
//
// jobSpec validation mirrors routes/search.js exactly (field is a non-empty
// string; criteria is a non-empty array; each criterion has a string key and
// numeric weight) so the two routes behave identically on malformed input.
// Error codes reuse the SAME opaque `(Rxxx)` style as routes/search.js — see
// docs/ERROR_CODES.md for what each code means.

import { Router } from "express";
import { agentSearch } from "../lib/agent/orchestrate.js";

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
    const { jobSpec, topN, options } = req.body || {};

    if (!isValidJobSpec(jobSpec)) {
      return sendError(res, 400, "Invalid job spec", "R001");
    }

    const result = await agentSearch(jobSpec, { ...(options || {}), topN });

    res.json(result);
  } catch (err) {
    console.error("Agent search error:", err);
    sendError(res, 500, "Internal server error", "R500");
  }
});

export default router;
