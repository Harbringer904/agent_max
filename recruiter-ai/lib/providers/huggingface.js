// lib/providers/huggingface.js
//
// Hugging Face provider — searches the free, no-key Hugging Face Models API
// for models matching skills/title from the jobSpec, then groups results by
// author to build one ML/AI candidate per publisher.
//
// Exports:
//   provider   { key:"huggingface", label:"Hugging Face (ML/AI)", fields:["software"], search(jobSpec, options) }

import { normalizeCandidate } from "../normalize.js";

const API_BASE = "https://huggingface.co/api/models";
const TIMEOUT_MS = 15_000;
const MAX_CANDIDATES = 15;
const LIMIT = 50;

// Best-effort filter for well-known vendor/org accounts rather than
// individual practitioners. Not exhaustive — just the obvious ones.
const SKIP_ORGS = new Set([
  "meta-llama",
  "openai",
  "google",
  "microsoft",
  "mistralai",
  "stabilityai",
]);

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Hugging Face API ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function searchQuery(jobSpec) {
  const requiredSkills = (jobSpec?.criteria || []).find((c) => c.key === "skills")?.requiredSkills || [];
  if (requiredSkills.length > 0) {
    return requiredSkills.slice(0, 2).join(" ");
  }
  return jobSpec?.title || null;
}

function toCandidate(author, index) {
  const skills = [...author.tagSet].slice(0, 10);
  const topModels = author.models
    .slice()
    .sort((a, b) => (b.downloads || 0) - (a.downloads || 0))
    .slice(0, 5)
    .map((m) => m.id);

  return normalizeCandidate(
    {
      id: `huggingface:${author.author}`,
      name: author.author,
      headline: `Hugging Face — ${author.models.length} model${author.models.length === 1 ? "" : "s"}, ${author.totalDownloads} downloads`,
      field: "software",
      location: null,
      yearsExperience: null,
      education: null,
      educationLevel: null,
      skills,
      certifications: [],
      summary: topModels.join(" | ") || null,
      sourceUrl: `https://huggingface.co/${author.author}`,
      avatarUrl: null,
      raw: {
        modelCount: author.models.length,
        totalDownloads: author.totalDownloads,
        topModels,
      },
    },
    "huggingface",
    index
  );
}

export const provider = {
  key: "huggingface",
  label: "Hugging Face (ML/AI)",
  fields: ["software"],

  async search(jobSpec, _options = {}) {
    try {
      const q = searchQuery(jobSpec);
      if (!q) return [];

      const url = `${API_BASE}?search=${encodeURIComponent(q)}&limit=${LIMIT}`;
      const models = await fetchJson(url);
      if (!Array.isArray(models) || models.length === 0) return [];

      const authors = new Map();
      for (const model of models) {
        const modelId = model?.id;
        if (!modelId || typeof modelId !== "string" || !modelId.includes("/")) continue;
        const author = model.author || modelId.split("/")[0];
        if (!author || SKIP_ORGS.has(author.toLowerCase())) continue;

        if (!authors.has(author)) {
          authors.set(author, { author, models: [], tagSet: new Set(), totalDownloads: 0 });
        }
        const entry = authors.get(author);
        const downloads = Number.isFinite(model.downloads) ? model.downloads : 0;
        entry.models.push({ id: modelId, downloads });
        entry.totalDownloads += downloads;
        for (const t of model.tags || []) {
          if (t) entry.tagSet.add(t);
        }
        if (model.pipeline_tag) entry.tagSet.add(model.pipeline_tag);
      }

      return [...authors.values()].slice(0, MAX_CANDIDATES).map((author, i) => toCandidate(author, i));
    } catch (err) {
      console.warn(`[recruiter-ai] Hugging Face provider failed: ${err.message}`);
      return [];
    }
  },
};
