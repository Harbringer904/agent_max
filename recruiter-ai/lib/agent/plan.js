import { listProviders } from "../providers/index.js";
import { openWebAvailable } from "../providers/openWeb.js";
import { hasGooglePlacesKey } from "../providers/googlePlaces.js";
import { activeLLMProvider } from "../scoring/llm.js";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_LLM_SOURCES = 6;

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_MODEL = "claude-sonnet-5";

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const FIELD_SOURCE_MAP = Object.freeze({
  software: [
    { providerKey: "github", reason: "software field: developer profiles with a real public API" },
    { providerKey: "stackoverflow", reason: "software field: technical reputation and expertise signals" },
    { providerKey: "hn_hiring", reason: "software field: Hacker News \"Who is hiring\" community" },
    { providerKey: "devto", reason: "software field: developer blogging/portfolio platform" },
    { providerKey: "huggingface", reason: "software field: ML/AI practitioner profiles" },
  ],
  finance: [
    { providerKey: "sebi_ria", reason: "finance field: official SEBI Registered Investment Adviser registry" },
    { providerKey: "finra", reason: "finance field: official FINRA BrokerCheck registry" },
  ],
  healthcare: [
    { providerKey: "nmc", reason: "healthcare field: official National Medical Commission registry" },
    { providerKey: "npi", reason: "healthcare field: official NPI registry (US CMS)" },
  ],
  research: [
    { providerKey: "orcid", reason: "research field: ORCID researcher identifiers" },
    { providerKey: "openalex", reason: "research field: OpenAlex scholarly works index" },
  ],
});

function buildBaseline(jobSpec, options) {
  const plan = [];
  const seen = new Set();
  const pushOnce = (providerKey, reason) => {
    if (seen.has(providerKey)) return;
    seen.add(providerKey);
    plan.push({ providerKey, reason });
  };

  const field = String(jobSpec?.field || "").toLowerCase().trim();
  for (const entry of FIELD_SOURCE_MAP[field] || []) {
    pushOnce(entry.providerKey, entry.reason);
  }

  const location = typeof jobSpec?.location === "string" ? jobSpec.location.trim() : "";
  if (location) {
    pushOnce("google_places", "location given: local business index");
    pushOnce("osm", "location given: OpenStreetMap points of interest");
  }

  if (openWebAvailable()) {
    pushOnce("open_web", "open web search available (LLM + Tavily key configured): broadens recall beyond structured registries");
  }

  if (typeof options?.data === "string" && options.data.trim().length > 0) {
    pushOnce("upload", "recruiter-supplied file included in this search");
  }

  return plan;
}

function filterAvailability(plan, log) {
  const filtered = [];
  for (const entry of plan) {
    if (entry.providerKey === "google_places" && !hasGooglePlacesKey()) {
      log.push("dropped google_places: no GOOGLE_PLACES_API_KEY configured");
      continue;
    }
    if (entry.providerKey === "open_web" && !openWebAvailable()) {
      log.push("dropped open_web: requires both an LLM key and TAVILY_API_KEY");
      continue;
    }
    filtered.push(entry);
  }
  return filtered;
}

const PLANNER_TOOL_NAME = "submit_source_plan";

const PLANNER_INPUT_SCHEMA = {
  type: "object",
  properties: {
    add: {
      type: "array",
      description: "Registered provider keys to add beyond the deterministic baseline, each with a short reason.",
      items: {
        type: "object",
        properties: {
          providerKey: { type: "string", description: "Must be one of the registered provider keys given above." },
          reason: { type: "string", description: "Short reason this source is relevant to this job." },
        },
        required: ["providerKey", "reason"],
      },
    },
    skip: {
      type: "array",
      description: "Provider keys from the deterministic baseline to skip, each with a short reason.",
      items: {
        type: "object",
        properties: {
          providerKey: { type: "string" },
          reason: { type: "string" },
        },
        required: ["providerKey", "reason"],
      },
    },
  },
  required: ["add", "skip"],
};

const ANTHROPIC_TOOL = {
  name: PLANNER_TOOL_NAME,
  description: "Propose sources to ADD to or SKIP from the deterministic candidate-sourcing plan. This can only change list membership, never scores or ordering.",
  input_schema: PLANNER_INPUT_SCHEMA,
};

const GROQ_FUNCTION = {
  name: PLANNER_TOOL_NAME,
  description: ANTHROPIC_TOOL.description,
  parameters: PLANNER_INPUT_SCHEMA,
};

const GEMINI_ITEM_SCHEMA = {
  type: "OBJECT",
  properties: {
    providerKey: { type: "STRING" },
    reason: { type: "STRING" },
  },
  required: ["providerKey", "reason"],
};

const GEMINI_FUNCTION = {
  name: PLANNER_TOOL_NAME,
  description: ANTHROPIC_TOOL.description,
  parameters: {
    type: "OBJECT",
    properties: {
      add: { type: "ARRAY", items: GEMINI_ITEM_SCHEMA },
      skip: { type: "ARRAY", items: GEMINI_ITEM_SCHEMA },
    },
    required: ["add", "skip"],
  },
};

function buildPlannerPrompt(jobSpec, currentPlan) {
  const registered = listProviders()
    .filter((p) => p.key !== "sample" && p.key !== "upload")
    .map((p) => `- ${p.key} (fields: ${(p.fields || []).join(", ")}): ${p.label}`)
    .join("\n");

  const currentList = currentPlan.length > 0 ? currentPlan.map((e) => `- ${e.providerKey}: ${e.reason}`).join("\n") : "(none)";

  return `You are refining a candidate-sourcing plan for an autonomous recruiting agent.

Job: title="${jobSpec?.title || ""}", field="${jobSpec?.field || ""}"${jobSpec?.location ? `, location="${jobSpec.location}"` : ""}

A deterministic baseline already selected these sources:
${currentList}

All registered sources you may choose among:
${registered}

You may ADD registered sources that are missing but clearly relevant to this job, or SKIP baseline sources that are clearly irrelevant. Give a short, specific reason for each change. Never propose "sample" (fabricated demo data) or "upload" (only the recruiter can supply that). You are ONLY choosing which sources to query — you do not score or rank candidates. Call ${PLANNER_TOOL_NAME} with your proposal; empty add/skip arrays are fine if the baseline already looks right.`;
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callAnthropicPlanner(jobSpec, currentPlan) {
  const response = await fetchWithTimeout(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      tools: [ANTHROPIC_TOOL],
      tool_choice: { type: "tool", name: PLANNER_TOOL_NAME },
      messages: [{ role: "user", content: buildPlannerPrompt(jobSpec, currentPlan) }],
    }),
  });

  if (!response.ok) throw new Error(`Anthropic API returned ${response.status}`);

  const data = await response.json();
  const toolUseBlock = Array.isArray(data.content)
    ? data.content.find((b) => b && b.type === "tool_use" && b.name === PLANNER_TOOL_NAME)
    : null;

  if (!toolUseBlock || !toolUseBlock.input) {
    throw new Error(`Malformed or missing ${PLANNER_TOOL_NAME} tool call in Anthropic response`);
  }
  return toolUseBlock.input;
}

async function callGroqPlanner(jobSpec, currentPlan) {
  const response = await fetchWithTimeout(GROQ_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: "user", content: buildPlannerPrompt(jobSpec, currentPlan) }],
      tools: [{ type: "function", function: GROQ_FUNCTION }],
      tool_choice: { type: "function", function: { name: PLANNER_TOOL_NAME } },
    }),
  });

  if (!response.ok) throw new Error(`Groq API returned ${response.status}`);

  const data = await response.json();
  const toolCall = data?.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall || !toolCall.function || typeof toolCall.function.arguments !== "string") {
    throw new Error("Malformed or missing tool call in Groq response");
  }

  let parsed;
  try {
    parsed = JSON.parse(toolCall.function.arguments);
  } catch {
    throw new Error("Failed to parse Groq tool call arguments as JSON");
  }
  return parsed;
}

async function callGeminiPlanner(jobSpec, currentPlan) {
  const url = `${GEMINI_API_URL}?key=${process.env.GEMINI_API_KEY}`;
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: buildPlannerPrompt(jobSpec, currentPlan) }] }],
      tools: [{ functionDeclarations: [GEMINI_FUNCTION] }],
      toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [PLANNER_TOOL_NAME] } },
    }),
  });

  if (!response.ok) throw new Error(`Gemini API returned ${response.status}`);

  const data = await response.json();
  const parts = data?.candidates?.[0]?.content?.parts;
  const functionCallPart = Array.isArray(parts)
    ? parts.find((p) => p && p.functionCall && p.functionCall.name === PLANNER_TOOL_NAME)
    : null;

  const args = functionCallPart?.functionCall?.args;
  if (!args) throw new Error("Malformed or missing functionCall in Gemini response");
  return args;
}

async function callPlannerLLM(provider, jobSpec, currentPlan) {
  if (provider === "anthropic") return callAnthropicPlanner(jobSpec, currentPlan);
  if (provider === "groq") return callGroqPlanner(jobSpec, currentPlan);
  return callGeminiPlanner(jobSpec, currentPlan);
}

const KNOWN_PROVIDER_KEYS = new Set(listProviders().map((p) => p.key));

function applyLLMProposal(currentPlan, proposal, log) {
  let plan = currentPlan.slice();
  const present = new Set(plan.map((e) => e.providerKey));

  const skips = Array.isArray(proposal?.skip) ? proposal.skip : [];
  for (const s of skips) {
    const key = s && typeof s.providerKey === "string" ? s.providerKey : null;
    if (!key || !present.has(key)) continue;
    plan = plan.filter((e) => e.providerKey !== key);
    present.delete(key);
    log.push(`LLM skipped ${key}: ${String(s.reason || "").trim() || "no reason given"}`);
  }

  const adds = Array.isArray(proposal?.add) ? proposal.add : [];
  for (const a of adds) {
    if (plan.length >= MAX_LLM_SOURCES) break;
    const key = a && typeof a.providerKey === "string" ? a.providerKey : null;
    if (!key) continue;
    if (key === "sample") continue;
    if (!KNOWN_PROVIDER_KEYS.has(key)) continue;
    if (present.has(key)) continue;
    if (key === "google_places" && !hasGooglePlacesKey()) continue;
    if (key === "open_web" && !openWebAvailable()) continue;

    const reason = String(a.reason || "").trim() || "LLM judged this source relevant";
    plan.push({ providerKey: key, reason: `LLM added: ${reason}` });
    present.add(key);
    log.push(`LLM added ${key}: ${reason}`);
  }

  if (plan.length > MAX_LLM_SOURCES) plan = plan.slice(0, MAX_LLM_SOURCES);
  return plan;
}

async function refineWithLLM(jobSpec, currentPlan, log) {
  const provider = activeLLMProvider();
  try {
    const proposal = await callPlannerLLM(provider, jobSpec, currentPlan);
    const refined = applyLLMProposal(currentPlan, proposal, log);

    if (refined.length === 0 && currentPlan.length > 0) {
      log.push("LLM proposal would have skipped every source; keeping deterministic plan instead");
      return currentPlan;
    }
    return refined;
  } catch (err) {
    log.push(`LLM source refinement failed (${provider}), keeping deterministic plan: ${err.message}`);
    return currentPlan;
  }
}

/**
 * Decide which registered providers to query for a jobSpec, with no source
 * picker involved. Deterministic and synchronous-fast by default; optionally
 * refined by one bounded LLM call when a key is configured.
 *
 * @param {object} jobSpec
 * @param {object} [options] - { data?: string, useLLM?: boolean }
 *   options.data   - recruiter-uploaded CSV/JSON text, if any (enables `upload`)
 *   options.useLLM - pass `false` to force the deterministic-only path even
 *                    when an LLM key is configured (also the knob tests use
 *                    to stay network-free)
 * @returns {Promise<{ sources: string[], sourcePlan: {providerKey:string, reason:string}[], log: string[] }>}
 */
export async function selectSources(jobSpec, options = {}) {
  const log = [];

  const baseline = buildBaseline(jobSpec, options);
  let plan = filterAvailability(baseline, log);

  const provider = activeLLMProvider();
  if (provider !== null && options?.useLLM !== false) {
    plan = await refineWithLLM(jobSpec, plan, log);
  } else if (provider === null) {
    log.push("LLM source refinement skipped: no LLM API key configured (deterministic plan only)");
  } else {
    log.push("LLM source refinement skipped: useLLM=false");
  }

  if (plan.length === 0) {
    log.push("no sources selected for this job spec (no field mapping, no location, and no optional sources available)");
  }

  return {
    sources: plan.map((e) => e.providerKey),
    sourcePlan: plan,
    log,
  };
}
