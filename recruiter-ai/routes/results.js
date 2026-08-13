// routes/results.js
//
// POST /api/results     { jobSpec, candidates, scoredBy } -> { id, url:"/?r=<id>" }
// GET  /api/results/:id -> saved payload | 404 { error }
//
// Request body/params are validated before touching the store; violations respond
// with an opaque coded error. See docs/ERROR_CODES.md for the code meanings.

import { Router } from "express";
import { saveResult, getResult } from "../lib/resultsStore.js";

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

router.post("/", (req, res) => {
  try {
    const { jobSpec, candidates, scoredBy } = req.body || {};

    if (!isValidJobSpec(jobSpec)) {
      return sendError(res, 400, "Invalid job spec", "R001");
    }

    if (!Array.isArray(candidates) || candidates.length === 0) {
      return sendError(res, 400, "Candidates must be a non-empty array", "R003");
    }

    const id = saveResult({ jobSpec, candidates, scoredBy });

    res.json({ id, url: `/?r=${id}` });
  } catch (err) {
    console.error("Save result error:", err);
    sendError(res, 500, "Internal server error", "R500");
  }
});

router.get("/:id", (req, res) => {
  try {
    const result = getResult(req.params.id);

    if (!result) {
      return sendError(res, 404, "Result not found", "R004");
    }

    res.json(result);
  } catch (err) {
    console.error("Get result error:", err);
    sendError(res, 500, "Internal server error", "R500");
  }
});

export default router;
