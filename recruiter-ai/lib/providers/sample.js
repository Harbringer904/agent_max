// lib/providers/sample.js
//
// Sample dataset provider — loads bundled synthetic candidates per field from
// data/samples/<field>.json, normalizes them, and filters by jobSpec.field.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { normalizeCandidate } from "../normalize.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = path.join(__dirname, "..", "..", "data", "samples");

// A field key doesn't always match its data file's basename (e.g. the
// "healthcare" field's candidates live in nursing.json).
const FIELD_TO_FILE = {
  healthcare: "nursing",
};

export const provider = {
  key: "sample",
  label: "Sample dataset",
  fields: ["*"],

  async search(jobSpec, _options = {}) {
    const field = String(jobSpec?.field || "").toLowerCase().trim();
    if (!field) return [];

    const fileBase = FIELD_TO_FILE[field] || field;
    const filePath = path.join(SAMPLES_DIR, `${fileBase}.json`);
    let rows;
    try {
      rows = JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      return [];
    }
    if (!Array.isArray(rows)) return [];

    return rows.map((row, i) => normalizeCandidate({ field, ...row }, "sample", i));
  },
};
