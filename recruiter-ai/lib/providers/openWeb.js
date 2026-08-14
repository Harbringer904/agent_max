// lib/providers/openWeb.js
//
// The genuinely "agentic" provider: an LLM in a multi-turn tool-calling loop
// that searches the open web and reads pages ON ITS OWN to find real
// candidates for ANY field/location — not a fixed integration like the other
// providers. This is the closest thing in the app to "browse the web and
// find whoever fits," which is what agentic search actually requires:
// dynamic decisions, not a hardcoded query.
//
// Two SEPARATE free keys are required (this provider needs both):
//   - An LLM to drive the reasoning loop: ANTHROPIC_API_KEY / GROQ_API_KEY /
//     GEMINI_API_KEY (same auto-detection as lib/scoring/llm.js — reused
//     here via activeLLMProvider()).
//   - TAVILY_API_KEY — Tavily (tavily.com) is a free, no-card, web
//     search+extract API purpose-built for AI agents (1000 free
//     searches/month). Generic public search engines (DuckDuckGo, public
//     SearXNG instances) were tested and reject automated/sandboxed
//     traffic with bot-detection challenges — verified before choosing
//     Tavily instead of building against something that would fail.
//
// Without BOTH keys, this provider returns [] — same graceful-degradation
// contract as every other provider. It never touches ToS-gated sites
// (LinkedIn, etc.) — the agent only sees what Tavily's search index surfaces,
// and Tavily itself respects standard web crawling norms.
//
// Loop: give the model `web_search` and `web_extract` tools plus a
// `submit_candidates` tool; let it decide how many searches/reads to do
// (capped) before submitting. Three LLM backends, three different
// tool-calling wire formats — see the per-provider step functions below.
//
// Exports:
//   provider   { key:"open_web", label, fields:["*"], search(jobSpec, options) }

import { normalizeCandidate } from "../normalize.js";
import { activeLLMProvider } from "../scoring/llm.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_MODEL = "claude-sonnet-5";

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract";

const REQUEST_TIMEOUT_MS = 25_000;
const MAX_TURNS = 6; // hard cap on agent loop iterations — bounds cost/latency
const MAX_CANDIDATES = 10; // fewer than structured sources — this is noisier data

export function hasTavilyKey() {
  return typeof process.env.TAVILY_API_KEY === "string" && process.env.TAVILY_API_KEY.length > 0;
}

/** True only when BOTH an LLM key and a Tavily key are present. */
export function openWebAvailable() {
  return activeLLMProvider() !== null && hasTavilyKey();
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

// --- Tavily tools (shared across all three LLM backends) -------------------

async function tavilySearch(query) {
  const res = await fetchWithTimeout(TAVILY_SEARCH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      max_results: 5,
      search_depth: "basic",
    }),
  });
  if (!res.ok) throw new Error(`Tavily search ${res.status}`);
  const data = await res.json();
  const results = Array.isArray(data.results) ? data.results : [];
  return results.map((r) => ({ title: r.title, url: r.url, snippet: (r.content || "").slice(0, 500) }));
}

async function tavilyExtract(url) {
  const res = await fetchWithTimeout(TAVILY_EXTRACT_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, urls: [url] }),
  });
  if (!res.ok) throw new Error(`Tavily extract ${res.status}`);
  const data = await res.json();
  const result = Array.isArray(data.results) ? data.results[0] : null;
  return result?.raw_content ? result.raw_content.slice(0, 4000) : "(no content extracted)";
}

/** Execute a tool call by name, returning a string result for the model.
 * Never throws — a failed tool call becomes a result the model can react to
 * (real agentic behavior: it can try something else instead of the whole
 * search failing). */
async function runTool(name, args) {
  try {
    if (name === "web_search") {
      const results = await tavilySearch(String(args.query || ""));
      return JSON.stringify(results);
    }
    if (name === "web_extract") {
      const text = await tavilyExtract(String(args.url || ""));
      return text;
    }
    return `Unknown tool: ${name}`;
  } catch (err) {
    return `Tool "${name}" failed: ${err.message}`;
  }
}

function buildSystemPrompt(jobSpec) {
  const criteriaDesc = (jobSpec.criteria || [])
    .map((c) => `- ${c.label || c.key}`)
    .join("\n");
  return `You are a recruiting research agent. Find REAL candidates on the open web who plausibly fit this role:

Field: ${jobSpec.field || "unspecified"}
Title: ${jobSpec.title || "unspecified"}
Location: ${jobSpec.location || "any"}
What matters for this role:
${criteriaDesc || "(no specific criteria given)"}

You have two tools: web_search(query) to search the web, and web_extract(url) to read a
page's full text. Use them as many times as you need (you have up to ${MAX_TURNS} turns) to
find real people — e.g. public portfolios, personal sites, professional profile pages,
directories — do NOT invent anyone. When you have found some real candidates (even just 2-3
is fine — quality over quantity), call submit_candidates with what you found. If you find
nothing credible after searching, call submit_candidates with an empty array. Never fabricate
a person, url, or detail that you did not actually see in a tool result.`;
}

const SUBMIT_CANDIDATES_SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      description: "Real candidates found via web_search/web_extract. Empty array if none found.",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          headline: { type: "string", description: "One-line role/title, from what you actually saw" },
          location: { type: "string" },
          skills: { type: "array", items: { type: "string" } },
          summary: { type: "string", description: "1-2 sentences on why they fit, from real page content" },
          sourceUrl: { type: "string", description: "The exact URL where you found this person" },
        },
        required: ["name", "sourceUrl"],
      },
    },
  },
  required: ["candidates"],
};

// --- Per-backend agent loop --------------------------------------------------

async function runAnthropicLoop(systemPrompt) {
  const tools = [
    { name: "web_search", description: "Search the web.", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    { name: "web_extract", description: "Read a page's full text.", input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
    { name: "submit_candidates", description: "Submit the real candidates you found.", input_schema: SUBMIT_CANDIDATES_SCHEMA },
  ];
  let messages = [{ role: "user", content: systemPrompt }];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await fetchWithTimeout(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 2048, tools, messages }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}`);
    const data = await res.json();
    const blocks = Array.isArray(data.content) ? data.content : [];
    const submit = blocks.find((b) => b.type === "tool_use" && b.name === "submit_candidates");
    if (submit) return Array.isArray(submit.input?.candidates) ? submit.input.candidates : [];

    const toolUses = blocks.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) break; // model stopped without submitting — give up gracefully

    messages.push({ role: "assistant", content: blocks });
    const toolResults = await Promise.all(
      toolUses.map(async (t) => ({
        type: "tool_result",
        tool_use_id: t.id,
        content: await runTool(t.name, t.input || {}),
      }))
    );
    messages.push({ role: "user", content: toolResults });
  }
  return [];
}

async function runGroqLoop(systemPrompt) {
  const tools = [
    { type: "function", function: { name: "web_search", description: "Search the web.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
    { type: "function", function: { name: "web_extract", description: "Read a page's full text.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
    { type: "function", function: { name: "submit_candidates", description: "Submit the real candidates you found.", parameters: SUBMIT_CANDIDATES_SCHEMA } },
  ];
  let messages = [{ role: "user", content: systemPrompt }];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await fetchWithTimeout(GROQ_API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: GROQ_MODEL, messages, tools }),
    });
    if (!res.ok) throw new Error(`Groq ${res.status}`);
    const data = await res.json();
    const msg = data?.choices?.[0]?.message;
    const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
    const submit = toolCalls.find((t) => t.function?.name === "submit_candidates");
    if (submit) {
      try {
        const args = JSON.parse(submit.function.arguments);
        return Array.isArray(args.candidates) ? args.candidates : [];
      } catch {
        return [];
      }
    }
    if (toolCalls.length === 0) break;

    messages.push({ role: "assistant", content: msg.content || null, tool_calls: toolCalls });
    for (const t of toolCalls) {
      let args = {};
      try {
        args = JSON.parse(t.function.arguments);
      } catch {
        /* malformed args — runTool gets {} and reports appropriately via missing fields */
      }
      const result = await runTool(t.function.name, args);
      messages.push({ role: "tool", tool_call_id: t.id, content: result });
    }
  }
  return [];
}

async function runGeminiLoop(systemPrompt) {
  const functionDeclarations = [
    { name: "web_search", description: "Search the web.", parameters: { type: "OBJECT", properties: { query: { type: "STRING" } }, required: ["query"] } },
    { name: "web_extract", description: "Read a page's full text.", parameters: { type: "OBJECT", properties: { url: { type: "STRING" } }, required: ["url"] } },
    {
      name: "submit_candidates",
      description: "Submit the real candidates you found.",
      parameters: {
        type: "OBJECT",
        properties: {
          candidates: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                name: { type: "STRING" },
                headline: { type: "STRING" },
                location: { type: "STRING" },
                skills: { type: "ARRAY", items: { type: "STRING" } },
                summary: { type: "STRING" },
                sourceUrl: { type: "STRING" },
              },
              required: ["name", "sourceUrl"],
            },
          },
        },
        required: ["candidates"],
      },
    },
  ];
  let contents = [{ role: "user", parts: [{ text: systemPrompt }] }];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const url = `${GEMINI_API_URL}?key=${process.env.GEMINI_API_KEY}`;
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents, tools: [{ functionDeclarations }] }),
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}`);
    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const calls = parts.filter((p) => p.functionCall);
    const submit = calls.find((p) => p.functionCall.name === "submit_candidates");
    if (submit) {
      const args = submit.functionCall.args || {};
      return Array.isArray(args.candidates) ? args.candidates : [];
    }
    if (calls.length === 0) break;

    contents.push({ role: "model", parts });
    const responseParts = [];
    for (const call of calls) {
      const result = await runTool(call.functionCall.name, call.functionCall.args || {});
      responseParts.push({ functionResponse: { name: call.functionCall.name, response: { content: result } } });
    }
    contents.push({ role: "user", parts: responseParts });
  }
  return [];
}

function toCandidate(found, jobSpec, index) {
  return normalizeCandidate(
    {
      id: `open_web:${index}:${found.sourceUrl || found.name}`,
      name: found.name,
      headline: found.headline || jobSpec?.title || "",
      field: jobSpec?.field || "",
      location: found.location || null,
      yearsExperience: null,
      education: null,
      educationLevel: null,
      skills: Array.isArray(found.skills) ? found.skills : [],
      certifications: [],
      summary: found.summary || null,
      sourceUrl: found.sourceUrl || null,
      avatarUrl: null,
      raw: { foundVia: "open_web agent" },
    },
    "open_web",
    index
  );
}

export const provider = {
  key: "open_web",
  label: "Open Web Search (AI agent — needs 2 free keys)",
  fields: ["*"],

  async search(jobSpec, _options = {}) {
    if (!openWebAvailable()) return [];
    try {
      const systemPrompt = buildSystemPrompt(jobSpec);
      const backend = activeLLMProvider();
      let found;
      if (backend === "anthropic") found = await runAnthropicLoop(systemPrompt);
      else if (backend === "groq") found = await runGroqLoop(systemPrompt);
      else found = await runGeminiLoop(systemPrompt);

      const valid = (Array.isArray(found) ? found : []).filter((f) => f && f.name && f.sourceUrl);
      return valid.slice(0, MAX_CANDIDATES).map((f, i) => toCandidate(f, jobSpec, i));
    } catch (err) {
      console.warn(`[recruiter-ai] open_web provider failed: ${err.message}`);
      return [];
    }
  },
};
