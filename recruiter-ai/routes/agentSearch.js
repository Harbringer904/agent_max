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
