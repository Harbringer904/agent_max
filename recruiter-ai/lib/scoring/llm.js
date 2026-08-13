// lib/scoring/llm.js
//
// Optional LLM scoring layer (Phase 2, generalized in Phase 5). Hybrid
// design: the LLM judges each criterion's raw fit (0..1) + a short note +
// an overall reasoning; this module applies the weight math itself, reusing
// the exact round2/weighting logic from rules.js so LLM and rules scores are
// directly comparable.
//
// Three interchangeable backends, auto-detected by env var so users with a
// free key (Groq or Gemini) can enable reasoning without an Anthropic key:
//   ANTHROPIC_API_KEY -> anthropic (claude-sonnet-5)
//   GROQ_API_KEY       -> groq (llama-3.3-70b-versatile)
//   GEMINI_API_KEY      -> gemini (gemini-2.0-flash)
// Priority above, unless overridden by LLM_PROVIDER=anthropic|groq|gemini.
// Each adapter normalizes its response into the same shape:
//   { scores: [{ id, criteria: [{ key, raw, note }], reasoning }] }
// so the rest of this module (weight math, fallback, sorting) is backend-agnostic.
//
// Exports:
//   activeLLMProvider() -> "anthropic" | "groq" | "gemini" | null
//   llmAvailable() -> boolean
//   rankCandidatesLLM(candidates, jobSpec, topN=25) -> Scored[] (never throws)

import { rankCandidates } from "./rules.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_MODEL = "claude-sonnet-5";

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const REQUEST_TIMEOUT_MS = 30_000;

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Which provider is active, chosen by LLM_PROVIDER override (if it names a
 * provider whose key is actually present) or by priority:
 * anthropic > groq > gemini. Returns null if no key is present.
 */
export function activeLLMProvider() {
  const hasAnthropic = typeof process.env.ANTHROPIC_API_KEY === "string" && process.env.ANTHROPIC_API_KEY.length > 0;
  const hasGroq = typeof process.env.GROQ_API_KEY === "string" && process.env.GROQ_API_KEY.length > 0;
  const hasGemini = typeof process.env.GEMINI_API_KEY === "string" && process.env.GEMINI_API_KEY.length > 0;

  const override = process.env.LLM_PROVIDER;
  if (override === "anthropic" && hasAnthropic) return "anthropic";
  if (override === "groq" && hasGroq) return "groq";
  if (override === "gemini" && hasGemini) return "gemini";

  if (hasAnthropic) return "anthropic";
  if (hasGroq) return "groq";
  if (hasGemini) return "gemini";
  return null;
}

export function llmAvailable() {
  return activeLLMProvider() !== null;
}

/** Build a human-readable description of one criterion's requirement values. */
function describeCriterion(criterion) {
  const parts = [`key="${criterion.key}"`, `label="${criterion.label || ""}"`, `weight=${criterion.weight}`];
  switch (criterion.key) {
    case "skills":
      parts.push(`requiredSkills=${JSON.stringify(criterion.requiredSkills || [])}`);
      break;
    case "experience":
      parts.push(`minYears=${criterion.minYears ?? "none"}`);
      break;
    case "education":
      parts.push(`minEducationLevel=${criterion.minEducationLevel ?? "none"} (0=none..5=doctorate)`);
      break;
    case "certifications":
      parts.push(`requiredCerts=${JSON.stringify(criterion.requiredCerts || [])}`);
      break;
    case "location":
      parts.push(`desiredLocation=${criterion.desiredLocation || "none"}`);
      break;
    case "keyword":
      parts.push(`keywords=${JSON.stringify(criterion.keywords || [])}`);
      break;
  }
  return parts.join(", ");
}

function buildPrompt(candidates, jobSpec) {
  const criteriaDesc = (jobSpec.criteria || [])
    .map((c, i) => `${i + 1}. ${describeCriterion(c)}`)
    .join("\n");

  const candidatesForPrompt = candidates.map((c) => ({
    id: c.id,
    name: c.name,
    skills: c.skills || [],
    yearsExperience: c.yearsExperience ?? null,
    education: c.education ?? null,
    certifications: c.certifications || [],
    summary: c.summary ?? null,
  }));

  return `You are an expert technical recruiter evaluating candidates for a "${jobSpec.title || jobSpec.field || "role"}" position (field: "${jobSpec.field || "unspecified"}"${jobSpec.location ? `, location: "${jobSpec.location}"` : ""}).

Score EVERY candidate below against EACH of the following criteria. For each criterion, judge how well the candidate matches on a 0..1 scale (raw fit), where 0 = no match at all and 1 = fully meets/exceeds the requirement. Base your judgment only on the data given — do not assume facts not present.

Criteria:
${criteriaDesc}

Candidates:
${JSON.stringify(candidatesForPrompt, null, 2)}

For each candidate, call submit_scores with:
- id: the candidate's id (must match exactly)
- criteria: an array with one entry per criterion above, each with the criterion's "key", a "raw" score (0..1), and a short "note" explaining the judgment
- reasoning: a 1-2 sentence overall natural-language justification for how well this candidate fits the role

Score ALL ${candidatesForPrompt.length} candidates. Do not skip any.`;
}

// --- Tool / function-calling schemas, one shape per provider's dialect --------------------

const ANTHROPIC_TOOL = {
  name: "submit_scores",
  description:
    "Submit per-criterion raw fit scores (0..1) and an overall reasoning for every candidate provided.",
  input_schema: {
    type: "object",
    properties: {
      scores: {
        type: "array",
        description: "One entry per candidate, in any order.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "The candidate's id, matching the input exactly." },
            criteria: {
              type: "array",
              description: "One entry per criterion this candidate was judged against.",
              items: {
                type: "object",
                properties: {
                  key: {
                    type: "string",
                    description: "The criterion's key (e.g. skills, experience, education, certifications, location, keyword).",
                  },
                  raw: {
                    type: "number",
                    description: "Raw fit score for this criterion, 0..1.",
                  },
                  note: {
                    type: "string",
                    description: "Short explanation of the raw fit judgment for this criterion.",
                  },
                },
                required: ["key", "raw", "note"],
              },
            },
            reasoning: {
              type: "string",
              description: "1-2 sentence overall natural-language justification for this candidate's fit.",
            },
          },
          required: ["id", "criteria", "reasoning"],
        },
      },
    },
    required: ["scores"],
  },
};

// OpenAI-compatible (Groq) function schema — same logical shape as ANTHROPIC_TOOL.input_schema.
const GROQ_FUNCTION = {
  name: "submit_scores",
  description:
    "Submit per-criterion raw fit scores (0..1) and an overall reasoning for every candidate provided.",
  parameters: ANTHROPIC_TOOL.input_schema,
};

// Gemini function-declaration schema — same logical shape, uppercase JSON Schema types.
const GEMINI_FUNCTION = {
  name: "submit_scores",
  description:
    "Submit per-criterion raw fit scores (0..1) and an overall reasoning for every candidate provided.",
  parameters: {
    type: "OBJECT",
    properties: {
      scores: {
        type: "ARRAY",
        description: "One entry per candidate, in any order.",
        items: {
          type: "OBJECT",
          properties: {
            id: { type: "STRING", description: "The candidate's id, matching the input exactly." },
            criteria: {
              type: "ARRAY",
              description: "One entry per criterion this candidate was judged against.",
              items: {
                type: "OBJECT",
                properties: {
                  key: {
                    type: "STRING",
                    description: "The criterion's key (e.g. skills, experience, education, certifications, location, keyword).",
                  },
                  raw: {
                    type: "NUMBER",
                    description: "Raw fit score for this criterion, 0..1.",
                  },
                  note: {
                    type: "STRING",
                    description: "Short explanation of the raw fit judgment for this criterion.",
                  },
                },
                required: ["key", "raw", "note"],
              },
            },
            reasoning: {
              type: "STRING",
              description: "1-2 sentence overall natural-language justification for this candidate's fit.",
            },
          },
          required: ["id", "criteria", "reasoning"],
        },
      },
    },
    required: ["scores"],
  },
};

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/** Call Anthropic, return the normalized { scores: [...] } object. Throws on any failure. */
async function callAnthropic(candidates, jobSpec) {
  const response = await fetchWithTimeout(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 4096,
      tools: [ANTHROPIC_TOOL],
      tool_choice: { type: "tool", name: "submit_scores" },
      messages: [{ role: "user", content: buildPrompt(candidates, jobSpec) }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API returned ${response.status}`);
  }

  const data = await response.json();
  const toolUseBlock = Array.isArray(data.content)
    ? data.content.find((b) => b && b.type === "tool_use" && b.name === "submit_scores")
    : null;

  if (!toolUseBlock || !toolUseBlock.input || !Array.isArray(toolUseBlock.input.scores)) {
    throw new Error("Malformed or missing submit_scores tool call in Anthropic response");
  }

  return toolUseBlock.input;
}

/** Call Groq (OpenAI-compatible), return the normalized { scores: [...] } object. Throws on any failure. */
async function callGroq(candidates, jobSpec) {
  const response = await fetchWithTimeout(GROQ_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: "user", content: buildPrompt(candidates, jobSpec) }],
      tools: [{ type: "function", function: GROQ_FUNCTION }],
      tool_choice: { type: "function", function: { name: "submit_scores" } },
    }),
  });

  if (!response.ok) {
    throw new Error(`Groq API returned ${response.status}`);
  }

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

  if (!parsed || !Array.isArray(parsed.scores)) {
    throw new Error("Malformed submit_scores payload in Groq response");
  }

  return parsed;
}

/** Call Gemini, return the normalized { scores: [...] } object. Throws on any failure. */
async function callGemini(candidates, jobSpec) {
  const url = `${GEMINI_API_URL}?key=${process.env.GEMINI_API_KEY}`;
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: buildPrompt(candidates, jobSpec) }] }],
      tools: [{ functionDeclarations: [GEMINI_FUNCTION] }],
      toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["submit_scores"] } },
    }),
  });

  if (!response.ok) {
    throw new Error(`Gemini API returned ${response.status}`);
  }

  const data = await response.json();
  const parts = data?.candidates?.[0]?.content?.parts;
  const functionCallPart = Array.isArray(parts)
    ? parts.find((p) => p && p.functionCall && p.functionCall.name === "submit_scores")
    : null;

  const args = functionCallPart?.functionCall?.args;
  if (!args || !Array.isArray(args.scores)) {
    throw new Error("Malformed or missing functionCall in Gemini response");
  }

  return args;
}

/**
 * Apply jobSpec weight math to a candidate given the LLM's per-criterion raw
 * scores. Mirrors scoreCandidate() in rules.js exactly so LLM and rules
 * scores are directly comparable.
 */
function applyWeights(candidate, jobSpec, criteriaRawByKey) {
  const criteria = Array.isArray(jobSpec?.criteria) ? jobSpec.criteria : [];
  const criteriaScores = {};
  let sumWeighted = 0;
  let sumMax = 0;

  for (const criterion of criteria) {
    const weight = Number(criterion.weight) || 0;
    const llmEntry = criteriaRawByKey.get(criterion.key);
    const raw = llmEntry ? clamp01(Number(llmEntry.raw)) : 0;
    const note = llmEntry ? String(llmEntry.note || "") : "LLM did not score this criterion";
    const weighted = round2(raw * weight);
    const max = weight;

    criteriaScores[criterion.key] = { raw: round2(raw), weighted, max, note };
    sumWeighted += weighted;
    sumMax += max;
  }

  const totalScore = sumMax > 0 ? round2((sumWeighted / sumMax) * 100) : 0;
  const rank1to10 = Math.max(1, Math.min(10, Math.round(totalScore / 10)));

  return { ...candidate, criteriaScores, totalScore, rank1to10 };
}

function fallbackToRules(list, jobSpec, topN) {
  return rankCandidates(list, jobSpec, topN).map((c) => ({ ...c, scoredBy: "rules", reasoning: null }));
}

/**
 * Score candidates via the active LLM provider (Anthropic, Groq, or Gemini),
 * with the weight math applied locally. Falls back to the full rules-based
 * scorer on ANY failure (missing key, non-200, network error, timeout,
 * malformed/missing tool call, JSON parse failure) — never throws to the caller.
 */
export async function rankCandidatesLLM(candidates, jobSpec, topN = 25) {
  const list = Array.isArray(candidates) ? candidates : [];
  const provider = activeLLMProvider();

  if (!provider || list.length === 0) {
    return fallbackToRules(list, jobSpec, topN);
  }

  try {
    let normalized;
    if (provider === "anthropic") {
      normalized = await callAnthropic(list, jobSpec);
    } else if (provider === "groq") {
      normalized = await callGroq(list, jobSpec);
    } else {
      normalized = await callGemini(list, jobSpec);
    }

    const scoresById = new Map();
    for (const entry of normalized.scores) {
      if (!entry || typeof entry.id !== "string") continue;
      const criteriaRawByKey = new Map();
      if (Array.isArray(entry.criteria)) {
        for (const c of entry.criteria) {
          if (c && typeof c.key === "string") {
            criteriaRawByKey.set(c.key, c);
          }
        }
      }
      scoresById.set(entry.id, {
        criteriaRawByKey,
        reasoning: typeof entry.reasoning === "string" ? entry.reasoning : "",
      });
    }

    const scored = list.map((candidate) => {
      const llmResult = scoresById.get(candidate.id);
      if (!llmResult) {
        // Candidate omitted by the LLM: fall back to its rules score.
        const rulesScored = rankCandidates([candidate], jobSpec, 1)[0];
        return { ...rulesScored, scoredBy: "rules", reasoning: null };
      }
      const weighted = applyWeights(candidate, jobSpec, llmResult.criteriaRawByKey);
      return { ...weighted, reasoning: llmResult.reasoning, scoredBy: "llm" };
    });

    scored.sort((a, b) => b.totalScore - a.totalScore);
    return scored.slice(0, topN);
  } catch (err) {
    console.error(`LLM scoring failed (${provider}), falling back to rules:`, err.message);
    return fallbackToRules(list, jobSpec, topN);
  }
}
