// routes/health.js
//
// GET /api/health -> { ok:true, githubAuth:boolean, llmAvailable:boolean, llmProvider:string|null }

import { Router } from "express";
import { hasToken } from "../lib/providers/github.js";
import { llmAvailable, activeLLMProvider } from "../lib/scoring/llm.js";

const router = Router();

router.get("/", (_req, res) => {
  res.json({ ok: true, githubAuth: hasToken(), llmAvailable: llmAvailable(), llmProvider: activeLLMProvider() });
});

export default router;
