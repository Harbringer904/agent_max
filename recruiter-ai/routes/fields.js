// routes/fields.js
//
// GET /api/fields -> [{ key, label, providers:string[] }]
//
// Derived from the registered providers' `fields` lists and the field values
// present in JOB_TEMPLATES, so a field shows up here as soon as either a
// provider or a template declares it.

import { Router } from "express";
import { listProviders } from "../lib/providers/index.js";
import { JOB_TEMPLATES } from "../lib/jobTemplates.js";

const router = Router();

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

router.get("/", (_req, res) => {
  const providers = listProviders();

  const fieldKeys = new Set(JOB_TEMPLATES.map((t) => t.field));
  for (const provider of providers) {
    for (const f of provider.fields) {
      if (f !== "*") fieldKeys.add(f);
    }
  }

  const fields = [...fieldKeys].sort().map((key) => ({
    key,
    label: capitalize(key),
    providers: providers
      .filter((p) => p.fields.includes("*") || p.fields.includes(key))
      .map((p) => p.key),
  }));

  res.json(fields);
});

export default router;
