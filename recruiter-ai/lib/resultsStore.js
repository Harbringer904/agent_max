// lib/resultsStore.js
//
// Saved-results store backing shareable localhost result links.
// Persists { id, createdAt, jobSpec, candidates, scoredBy } as JSON files under data/results/.
//
// Exports:
//   saveResult({ jobSpec, candidates, scoredBy }) -> id
//   getResult(id) -> payload|null

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, "..", "data", "results");

// URL-safe id: base64url alphabet only, 1-64 chars. Guards against path traversal
// on both write (we generate it) and read (caller-supplied param is validated).
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function ensureDir() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

function isValidId(id) {
  return typeof id === "string" && ID_PATTERN.test(id);
}

export function saveResult({ jobSpec, candidates, scoredBy }) {
  ensureDir();

  let id;
  do {
    id = crypto.randomBytes(6).toString("base64url");
  } while (fs.existsSync(path.join(RESULTS_DIR, `${id}.json`)));

  const payload = {
    id,
    createdAt: new Date().toISOString(),
    jobSpec,
    candidates,
    scoredBy,
  };

  fs.writeFileSync(path.join(RESULTS_DIR, `${id}.json`), JSON.stringify(payload), "utf8");

  return id;
}

export function getResult(id) {
  if (!isValidId(id)) return null;

  const filePath = path.join(RESULTS_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}
