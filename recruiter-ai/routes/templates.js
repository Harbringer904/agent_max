// routes/templates.js
//
// GET /api/templates -> JobSpec[] (pre-built role templates)

import { Router } from "express";
import { JOB_TEMPLATES } from "../lib/jobTemplates.js";

const router = Router();

router.get("/", (_req, res) => {
  res.json(JOB_TEMPLATES);
});

export default router;
