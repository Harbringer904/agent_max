// lib/providers/upload.js
//
// Upload provider — parses recruiter-supplied CSV or JSON text (options.data)
// into unified Candidates. No parsing libraries; hand-rolled CSV support.
//
// CSV expectations: first row = headers, columns map to
// name/skills/experience/education/certifications/location/summary (case-
// insensitive header match). skills & certifications may be ";"-separated.
// Simple quoted fields ("...", with "" as an escaped quote) are supported.

import { normalizeCandidate } from "../normalize.js";

function parseCsvLine(line) {
  const fields = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields.map((f) => f.trim());
}

function parseCsv(text) {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase().trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] !== undefined ? values[idx] : "";
    });
    rows.push(row);
  }
  return rows;
}

function splitList(v) {
  if (v === undefined || v === null) return [];
  return String(v)
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

function csvRowToCandidatePartial(row, field) {
  return {
    name: row.name,
    field,
    location: row.location || null,
    yearsExperience:
      row.experience !== undefined && row.experience !== "" ? Number(row.experience) : null,
    education: row.education || null,
    skills: splitList(row.skills),
    certifications: splitList(row.certifications),
    summary: row.summary || null,
    headline: row.headline || row.summary || row.name,
  };
}

export const provider = {
  key: "upload",
  label: "Upload CSV/JSON",
  fields: ["*"],
  traits: {
    // CSV rows never carry a URL column at all; JSON input could set an
    // arbitrary sourceUrl, but nothing here verifies what it points to —
    // false is the safe default for an unverified, caller-supplied field.
    sourceUrlIdentifiesPerson: false,
    nameIsHandle: false,
    dataIsLLMExtracted: false,
    entityType: "person",
  },

  async search(jobSpec, options = {}) {
    const data = String(options?.data || "");
    const trimmed = data.trim();
    if (!trimmed) return [];

    const field = String(jobSpec?.field || "").toLowerCase().trim();

    let partials;
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      const parsed = JSON.parse(trimmed);
      partials = Array.isArray(parsed) ? parsed : [parsed];
    } else {
      partials = parseCsv(trimmed).map((row) => csvRowToCandidatePartial(row, field));
    }

    return partials.map((p, i) => normalizeCandidate({ field, ...p }, "upload", i));
  },
};
