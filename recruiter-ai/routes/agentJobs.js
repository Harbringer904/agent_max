// routes/agentJobs.js
//
// PLAN_V2 §5 Phase 5 — async counterpart to POST /api/agent-search.
//
//   POST /api/agent-search/jobs        { jobSpec, topN, options } -> 202 { jobId }
//   GET  /api/agent-search/jobs/:jobId -> the job snapshot (lib/agent/jobs.js)
//
// jobSpec validation is byte-for-byte the same as routes/agentSearch.js, and
// reuses the same opaque Rxxx error style (see docs/ERROR_CODES.md). The
// existing blocking POST /api/agent-search is untouched — this is a new,
// additive surface for long-running searches so the UI can show live
// progress instead of holding one request open for up to 60s.

import { Router } from "express";
import { createJob, getJob, isValidJobId } from "../lib/agent/jobs.js";

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
    const { jobSpec, topN, options } = req.body || {};

    if (!isValidJobSpec(jobSpec)) {
      return sendError(res, 400, "Invalid job spec", "R001");
    }

    const jobId = createJob(jobSpec, { ...(options || {}), topN });

    res.status(202).json({ jobId });
  } catch (err) {
    console.error("Agent search job creation error:", err);
    sendError(res, 500, "Internal server error", "R500");
  }
});

router.get("/:jobId", (req, res) => {
  try {
    if (!isValidJobId(req.params.jobId)) {
      return sendError(res, 404, "Job not found", "R005");
    }

    const job = getJob(req.params.jobId);
    if (!job) {
      return sendError(res, 404, "Job not found", "R005");
    }

    res.json(job);
  } catch (err) {
    console.error("Agent search job lookup error:", err);
    sendError(res, 500, "Internal server error", "R500");
  }
});

export default router;
