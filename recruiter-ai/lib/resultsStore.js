import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, "..", "data", "results");

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
