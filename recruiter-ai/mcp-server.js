#!/usr/bin/env node
// mcp-server.js
//
// PLAN_V2.md Phase 6 — MCP front door onto the SAME autonomous agent core
// used by POST /api/agent-search. No new dependency: this is a hand-rolled,
// minimal JSON-RPC 2.0 server speaking the MCP stdio transport directly with
// Node built-ins only (no @modelcontextprotocol/sdk, per the project's
// zero-new-deps rule).
//
// Framing: one JSON-RPC message per line on stdin, one JSON-RPC message per
// line on stdout. Requests carry an `id` and get a response with that same
// `id` echoed back. Notifications (no `id`) get NO response, ever.
//
// *** STDOUT CARRIES ONLY JSON-RPC. *** Every log/diagnostic goes to stderr
// (console.error / process.stderr) — writing anything else to stdout is the
// single most common way a hand-rolled MCP server corrupts its own protocol
// stream and breaks the client parsing it.
//
// Capability surface: tools only. No resources, no prompts, no sampling —
// see docs/MCP.md for the honest scope statement.
//
// Methods handled:
//   initialize                  -> { protocolVersion, capabilities, serverInfo }
//   notifications/initialized   -> notification; no response sent
//   tools/list                  -> { tools: [...] } (the 3 tools below)
//   tools/call                  -> { content: [{ type:"text", text }], isError? }
//   anything else (with an id)  -> JSON-RPC error -32601 "Method not found"
//   anything else (no id)       -> silently ignored, per JSON-RPC notification rules
//
// Tools exposed (thin wrappers over lib/agent + lib/jobTemplates +
// lib/providers — the exact same modules routes/agentSearch.js, routes/
// fields.js, and routes/templates.js use; no duplicated logic, no HTTP call):
//   search_candidates   — build a JobSpec, run agentSearch(), return a
//                          human-readable ranked summary for a chat window
//   list_fields         — supported fields + which providers serve each
//   list_job_templates  — the built-in JOB_TEMPLATES
//
// Every tool catches its own errors and returns them as text content with
// isError:true rather than letting anything throw out of tools/call.

import dotenv from "dotenv";
import { createInterface } from "readline";

import { agentSearch } from "./lib/agent/orchestrate.js";
import { templatesForField, getTemplate, JOB_TEMPLATES } from "./lib/jobTemplates.js";
import { listProviders } from "./lib/providers/index.js";

dotenv.config();

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "recruiter-ai-mcp", version: "1.0.0" };
const DEFAULT_TOP_N = 5;

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "search_candidates",
    description:
      "Search for and rank candidates in a given field using the autonomous multi-source recruiting agent. The agent decides on its own which sources to query (official registries, developer platforms, open web, etc.), merges/dedupes results across sources, and returns one consolidated ranked list of up to topN candidates with provenance and confidence.",
    inputSchema: {
      type: "object",
      properties: {
        field: {
          type: "string",
          description:
            'Job field, e.g. "software", "finance", "healthcare", "research", "sales", "marketing", "design", "operations".',
        },
        title: {
          type: "string",
          description:
            'Job title, e.g. "Backend Engineer". Optional — matched against a built-in template when it matches one exactly for the given field.',
        },
        location: {
          type: "string",
          description: 'Desired candidate location, e.g. "Delhi". Optional.',
        },
        skills: {
          type: "array",
          items: { type: "string" },
          description: "Required skills/keywords. Optional.",
        },
        minYears: {
          type: "number",
          description: "Minimum years of experience. Optional.",
        },
        topN: {
          type: "number",
          description: "How many ranked candidates to return. Defaults to 5.",
        },
      },
      required: ["field"],
    },
  },
  {
    name: "list_fields",
    description:
      "List the job fields the recruiting agent supports, and which data-source providers serve each field.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_job_templates",
    description:
      "List the built-in job templates (field, title, and weighted criteria) available to seed a search_candidates call.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

// ---------------------------------------------------------------------------
// search_candidates — JobSpec construction
// ---------------------------------------------------------------------------

function cleanStringArray(v) {
  if (!Array.isArray(v)) return [];
  return v.map((s) => String(s ?? "").trim()).filter(Boolean);
}

/**
 * Build a JobSpec from tool input: reuse a built-in template
 * (lib/jobTemplates.js) as a starting point when the field (and optionally
 * title) match one, then let explicit skills/minYears override or extend
 * that template's criteria. When no template matches, synthesize criteria
 * directly from whatever was given. Always produces at least one criterion.
 */
function buildJobSpec(input) {
  const field = String(input?.field || "").trim();
  const title = typeof input?.title === "string" ? input.title.trim() : "";
  const location =
    typeof input?.location === "string" && input.location.trim() ? input.location.trim() : null;
  const skills = cleanStringArray(input?.skills);
  const minYearsNum = Number(input?.minYears);
  const minYears =
    input?.minYears !== undefined && input?.minYears !== null && Number.isFinite(minYearsNum)
      ? minYearsNum
      : null;

  // Use a built-in template ONLY when the caller actually named a title that
  // matches one. Previously this fell back to templatesForField(field)[0] when
  // no title was given — which silently scored everyone against an arbitrary
  // specific role. Verified live: `{ field: "finance", location: "Delhi" }`
  // picked the "Accountant" template (requires CPA, bookkeeping, GAAP), so real
  // SEBI-registered investment advisers came back rated 2/10 — excellent
  // matches made to look terrible because they were judged against a rubric the
  // caller never asked for. If no title is given, stay deliberately generic.
  const template = title ? getTemplate(field, title) : undefined;

  const criteria = template ? template.criteria.map((c) => ({ ...c })) : [];

  if (skills.length > 0) {
    const existing = criteria.find((c) => c.key === "skills");
    if (existing) existing.requiredSkills = skills;
    else criteria.push({ key: "skills", label: "Core Skills", weight: 5, requiredSkills: skills });
  }

  if (minYears !== null) {
    const existing = criteria.find((c) => c.key === "experience");
    if (existing) existing.minYears = minYears;
    else criteria.push({ key: "experience", label: "Years of Experience", weight: 3, minYears });
  }

  if (criteria.length === 0) {
    // Nothing specific was given (no matching template, no skills, no minYears)
    // — build broad, honest criteria rather than borrowing a specific role's
    // rubric. A location criterion is included when a location was supplied so
    // local candidates are actually rewarded, which is usually the caller's
    // intent when they pass one.
    const keywords = [title, field].filter(Boolean);
    criteria.push({
      key: "keyword",
      label: "Role Focus",
      weight: 3,
      keywords: keywords.length ? keywords : [field],
    });
    if (location) {
      criteria.push({ key: "location", label: "Location", weight: 2, desiredLocation: location });
    }
  }

  return {
    field,
    title: title || template?.title || field,
    location,
    criteria,
  };
}

// ---------------------------------------------------------------------------
// search_candidates — result formatting (a human reads this in a chat window)
// ---------------------------------------------------------------------------

function formatCandidateLine(c, i) {
  const name = c.name || "(unnamed)";
  const score = `${c.agentRank1to10}/10`;
  const trust = String(c.sourceTrust || "lead").toUpperCase();
  const completeness = Number.isFinite(c.dataCompleteness) ? `${Math.round(c.dataCompleteness * 100)}% data` : "n/a data";
  const headline = c.headline || c.summary || "";
  const location = c.location ? ` · ${c.location}` : "";
  const headlineLine = headline ? `\n     ${headline}` : "";
  const urlLine = c.sourceUrl ? `\n     ${c.sourceUrl}` : "";

  return `${i + 1}. ${name} — ${score} [${trust}, ${completeness}] via ${c.source}${location}${headlineLine}${urlLine}`;
}

function formatSearchResult(result, jobSpec, topN) {
  const lines = [];
  const locationSuffix = jobSpec.location ? ` in ${jobSpec.location}` : "";
  lines.push(`Search: "${jobSpec.title}" (${jobSpec.field})${locationSuffix}`);
  lines.push(
    `Found ${result.totalFound} candidate(s) across sources, ${result.matched} matched required filters, showing top ${result.candidates.length} (requested ${topN}), scored by ${result.scoredBy}.`
  );
  lines.push("");

  if (Array.isArray(result.sourcesQueried) && result.sourcesQueried.length > 0) {
    lines.push("Sources queried:");
    for (const sq of result.sourcesQueried) {
      lines.push(`  - ${sq.key}: ${sq.status}, ${sq.count} candidate(s), ${sq.ms}ms`);
    }
    lines.push("");
  }

  if (result.candidates.length === 0) {
    lines.push(
      "No candidates found matching this search. Synthetic sample data is deliberately excluded from the agent's search, so an empty result means no source had a real match for this field/location — not a hidden fallback."
    );
  } else {
    lines.push("Ranked candidates:");
    result.candidates.forEach((c, i) => lines.push(formatCandidateLine(c, i)));
  }

  return lines.join("\n");
}

async function toolSearchCandidates(input) {
  const field = typeof input?.field === "string" ? input.field.trim() : "";
  if (!field) {
    return 'Error: "field" is required (e.g. "software", "finance", "healthcare").';
  }

  const topNNum = Number(input?.topN);
  const topN = Number.isFinite(topNNum) && topNNum > 0 ? Math.round(topNNum) : DEFAULT_TOP_N;
  const jobSpec = buildJobSpec(input);

  // useLLM is deliberately forced false here: search_candidates is a single
  // synchronous chat-tool call, and this schema doesn't expose an LLM
  // toggle. This disables the optional LLM source-refinement pass in
  // lib/agent/plan.js and forces rules-based (not LLM) scoring, mirroring
  // the web UI's default (unchecked) "AI scoring" state. NOTE: it does NOT
  // disable open_web — that source is included by the deterministic
  // baseline whenever an LLM+Tavily key is configured (see
  // lib/providers/openWeb.js openWebAvailable()) and runs its own bounded
  // agentic loop against whichever LLM backend is configured, independent
  // of this flag.
  const result = await agentSearch(jobSpec, { topN, useLLM: false });

  return formatSearchResult(result, jobSpec, topN);
}

// ---------------------------------------------------------------------------
// list_fields
// ---------------------------------------------------------------------------

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function toolListFields() {
  const providers = listProviders();
  const fieldKeys = new Set(JOB_TEMPLATES.map((t) => t.field));
  for (const provider of providers) {
    for (const f of provider.fields) {
      if (f !== "*") fieldKeys.add(f);
    }
  }

  const lines = [...fieldKeys].sort().map((key) => {
    const servingProviders = providers
      .filter((p) => p.fields.includes("*") || p.fields.includes(key))
      .map((p) => p.key);
    return `- ${key} (${capitalize(key)}): ${servingProviders.join(", ") || "(none)"}`;
  });

  return `Supported fields:\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// list_job_templates
// ---------------------------------------------------------------------------

function describeCriterion(c) {
  const parts = [`${c.key} (weight ${c.weight})`];
  if (Array.isArray(c.requiredSkills) && c.requiredSkills.length) parts.push(`skills: ${c.requiredSkills.join(", ")}`);
  if (Array.isArray(c.requiredCerts) && c.requiredCerts.length) parts.push(`certs: ${c.requiredCerts.join(", ")}`);
  if (Array.isArray(c.keywords) && c.keywords.length) parts.push(`keywords: ${c.keywords.join(", ")}`);
  if (c.minYears) parts.push(`min ${c.minYears}yr`);
  if (c.minEducationLevel) parts.push(`min education level ${c.minEducationLevel}`);
  if (c.desiredLocation) parts.push(`location: ${c.desiredLocation}`);
  return parts.join(", ");
}

function toolListJobTemplates() {
  const byField = new Map();
  for (const t of JOB_TEMPLATES) {
    if (!byField.has(t.field)) byField.set(t.field, []);
    byField.get(t.field).push(t);
  }

  const lines = [];
  for (const [field, templates] of [...byField.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${field}:`);
    for (const t of templates) {
      lines.push(`  - ${t.title}`);
      for (const c of t.criteria) lines.push(`      ${describeCriterion(c)}`);
    }
  }

  return `Built-in job templates:\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function textContent(text) {
  return { content: [{ type: "text", text: String(text) }] };
}

async function callTool(name, args) {
  try {
    if (name === "search_candidates") return textContent(await toolSearchCandidates(args || {}));
    if (name === "list_fields") return textContent(toolListFields());
    if (name === "list_job_templates") return textContent(toolListJobTemplates());
    return { ...textContent(`Unknown tool: "${name}"`), isError: true };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return { ...textContent(`${name} failed: ${message}`), isError: true };
  }
}

async function handleRequest(req) {
  const { id, method, params } = req;

  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
    return;
  }

  if (method === "notifications/initialized") {
    // Notification — no id, no response, per JSON-RPC/MCP.
    return;
  }

  if (method === "tools/list") {
    sendResult(id, { tools: TOOLS });
    return;
  }

  if (method === "tools/call") {
    const result = await callTool(params?.name, params?.arguments);
    sendResult(id, result);
    return;
  }

  const hasId = id !== undefined && id !== null;
  if (!hasId) {
    // Unknown notification — per JSON-RPC, notifications are never responded to.
    return;
  }

  sendError(id, -32601, `Method not found: ${method}`);
}

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let req;
  try {
    req = JSON.parse(trimmed);
  } catch (err) {
    console.error(`mcp-server: failed to parse JSON-RPC line: ${err.message}`);
    sendError(null, -32700, "Parse error");
    return;
  }

  handleRequest(req).catch((err) => {
    console.error(`mcp-server: unhandled error handling "${req?.method}": ${(err && err.stack) || err}`);
    const hasId = req && req.id !== undefined && req.id !== null;
    if (hasId) sendError(req.id, -32603, "Internal error");
  });
});

process.stdin.on("end", () => {
  process.exit(0);
});

console.error("mcp-server: recruiter-ai MCP server ready on stdio");
