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
const MAX_TURNS = 6;
const MAX_CANDIDATES = 10;

export function hasTavilyKey() {
  return typeof process.env.TAVILY_API_KEY === "string" && process.env.TAVILY_API_KEY.length > 0;
}

/** True only when BOTH an LLM key and a Tavily key are present. */
export function openWebAvailable() {
  return activeLLMProvider() !== null && hasTavilyKey();
}

function clampBudgetValue(value, min, max, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Resolve a caller-supplied options object into a validated, clamped budget.
 * A solo call with no options resolves to exactly the module defaults, so
 * unbudgeted behavior is unchanged. */
export function resolveBudget(options) {
  const opts = options && typeof options === "object" ? options : {};
  return {
    maxTurns: clampBudgetValue(opts.maxTurns, 1, 10, MAX_TURNS),
    timeoutMs: clampBudgetValue(opts.timeoutMs, 5_000, 60_000, REQUEST_TIMEOUT_MS),
    maxCandidates: clampBudgetValue(opts.maxCandidates, 1, 25, MAX_CANDIDATES),
  };
}

async function fetchWithTimeout(url, options, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function tavilySearch(query, timeoutMs) {
  const res = await fetchWithTimeout(
    TAVILY_SEARCH_URL,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query,
        max_results: 5,
        search_depth: "basic",
      }),
    },
    timeoutMs
  );
  if (!res.ok) throw new Error(`Tavily search ${res.status}`);
  const data = await res.json();
  const results = Array.isArray(data.results) ? data.results : [];
  return results.map((r) => ({ title: r.title, url: r.url, snippet: (r.content || "").slice(0, 500) }));
}

async function tavilyExtract(url, timeoutMs) {
  const res = await fetchWithTimeout(
    TAVILY_EXTRACT_URL,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, urls: [url] }),
    },
    timeoutMs
  );
  if (!res.ok) throw new Error(`Tavily extract ${res.status}`);
  const data = await res.json();
  const result = Array.isArray(data.results) ? data.results[0] : null;
  return result?.raw_content ? result.raw_content.slice(0, 4000) : "(no content extracted)";
}

async function runTool(name, args, timeoutMs, corpus) {
  try {
    let out;
    if (name === "web_search") {
      const results = await tavilySearch(String(args.query || ""), timeoutMs);
      out = JSON.stringify(results);
    } else if (name === "web_extract") {
      out = await tavilyExtract(String(args.url || ""), timeoutMs);
    } else {
      return `Unknown tool: ${name}`;
    }
    if (Array.isArray(corpus)) corpus.push(out);
    return out;
  } catch (err) {
    return `Tool "${name}" failed: ${err.message}`;
  }
}

function normalizeForGrounding(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokensWereSeen(text, corpusText) {
  const n = normalizeForGrounding(text);
  if (!n) return false;
  const haystack = normalizeForGrounding(corpusText);
  if (!haystack) return false;
  const tokens = n.split(" ").filter((t) => t.length >= 3);
  if (tokens.length === 0) return haystack.includes(n);
  return tokens.every((t) => new RegExp(`(^|\\s)${t}(\\s|$)`).test(haystack));
}

/**
 * True only if the candidate's name demonstrably appeared in something the
 * agent actually read. See tokensWereSeen for the matching rule.
 */
export function nameWasSeen(name, corpusText) {
  return tokensWereSeen(name, corpusText);
}

/**
 * Ground a submitted `location` against the corpus of pages the agent
 * actually read this run. Returns the original location when it demonstrably
 * appears in the corpus, or null when it doesn't — the candidate itself is
 * never dropped for this.
 */
export function groundLocation(location, corpusText) {
  const loc = String(location || "").trim();
  if (!loc) return null;
  return tokensWereSeen(loc, corpusText) ? loc : null;
}

/**
 * Ground a submitted `skills` array against the corpus: keep only skills
 * whose text demonstrably appears in something the agent actually read,
 * dropping the rest. Never drops the candidate, only individual skills.
 */
export function groundSkills(skills, corpusText) {
  const list = Array.isArray(skills) ? skills : [];
  return list
    .map((s) => String(s || "").trim())
    .filter((s) => s && tokensWereSeen(s, corpusText));
}

function buildSystemPrompt(jobSpec, maxTurns) {
  const criteriaDesc = (jobSpec.criteria || [])
    .map((c) => `- ${c.label || c.key}`)
    .join("\n");
  const location = jobSpec.location || null;
  return `You are a recruiting research agent. Find REAL candidates on the open web who plausibly fit this role:

Field: ${jobSpec.field || "unspecified"}
Title: ${jobSpec.title || "unspecified"}
Location: ${jobSpec.location || "any"}
What matters for this role:
${criteriaDesc || "(no specific criteria given)"}

You have two tools: web_search(query) to search the web, and web_extract(url) to read a page's
full text. You have up to ${maxTurns} turns total this run, so use them deliberately.

SWEEP MULTIPLE SURFACES. Do not fire one generic query and stop — vary your queries across
DIFFERENT KINDS of surfaces across turns, picking whichever actually fit this field (a nurse
and a UX designer live on very different parts of the web). Draw from:
  - personal portfolio sites, personal domains, "about me" pages
  - public professional directories or association member listings
  - conference speaker pages / published-talk pages
  - public team / "our staff" pages on company sites
  - GitHub or Stack Overflow profiles cross-referenced with a name or personal site (technical fields)
  - "hire me" / "open to work" / freelancer-listing style pages
${location ? `Include "${location}" in your queries to anchor results to the right place.\n` : ""}
Do NOT trust search snippets alone — call web_extract on the most promising URLs before citing
a person, because snippets frequently omit the name, skills, or location you need to fill in a
candidate record. Prefer pages that are actually ABOUT one specific person over listicles or
aggregator articles ("10 best designers in ..."), which are not candidates.

STOP EARLY once you have found a few solid, real people — quality over quantity. You do not have
to use every turn. If nothing credible turns up, call submit_candidates with an empty array.

You must NEVER attempt to access LinkedIn, or any other login-gated or ToS-restricted platform.
You only ever see what the search tool's index legitimately surfaces — do not try to work around
that restriction.

THE SINGLE MOST IMPORTANT RULE: never invent a person, URL, skill, or location you did not
actually see in a tool result. If you are not sure a detail is real, leave it out rather than
guess. An empty candidates list is always better than a fabricated one.

The "name" field is REQUIRED for every candidate you submit, and this creates a specific trap:
if a page (e.g. a company/agency homepage) never actually states a specific person's name, do
NOT invent one just to satisfy the schema — SKIP that candidate entirely instead. Only submit a
candidate when you actually read that specific person's real name in a tool result. A company
description with no named individual is not a candidate, no matter how well it matches the role.

When you have found some real candidates (even just 2-3 is fine), call submit_candidates with
what you found.`;
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

async function runAnthropicLoop(systemPrompt, budget, corpus) {
  const tools = [
    { name: "web_search", description: "Search the web.", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    { name: "web_extract", description: "Read a page's full text.", input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
    { name: "submit_candidates", description: "Submit the real candidates you found.", input_schema: SUBMIT_CANDIDATES_SCHEMA },
  ];
  let messages = [{ role: "user", content: systemPrompt }];

  for (let turn = 0; turn < budget.maxTurns; turn++) {
    const res = await fetchWithTimeout(
      ANTHROPIC_API_URL,
      {
        method: "POST",
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 2048, tools, messages }),
      },
      budget.timeoutMs
    );
    if (!res.ok) throw new Error(`Anthropic ${res.status}`);
    const data = await res.json();
    const blocks = Array.isArray(data.content) ? data.content : [];
    const submit = blocks.find((b) => b.type === "tool_use" && b.name === "submit_candidates");
    if (submit) return Array.isArray(submit.input?.candidates) ? submit.input.candidates : [];

    const toolUses = blocks.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) break;

    messages.push({ role: "assistant", content: blocks });
    const toolResults = await Promise.all(
      toolUses.map(async (t) => ({
        type: "tool_result",
        tool_use_id: t.id,
        content: await runTool(t.name, t.input || {}, budget.timeoutMs, corpus),
      }))
    );
    messages.push({ role: "user", content: toolResults });
  }
  return [];
}

async function runGroqLoop(systemPrompt, budget, corpus) {
  const tools = [
    { type: "function", function: { name: "web_search", description: "Search the web.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
    { type: "function", function: { name: "web_extract", description: "Read a page's full text.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
    { type: "function", function: { name: "submit_candidates", description: "Submit the real candidates you found.", parameters: SUBMIT_CANDIDATES_SCHEMA } },
  ];
  let messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: "Begin your research now." },
  ];

  for (let turn = 0; turn < budget.maxTurns; turn++) {
    const res = await fetchWithTimeout(
      GROQ_API_URL,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ model: GROQ_MODEL, messages, tools, tool_choice: "auto", temperature: 0, parallel_tool_calls: false }),
      },
      budget.timeoutMs
    );
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
      }
      const result = await runTool(t.function.name, args, budget.timeoutMs, corpus);
      messages.push({ role: "tool", tool_call_id: t.id, content: result });
    }
  }
  return [];
}

async function runGeminiLoop(systemPrompt, budget, corpus) {
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

  for (let turn = 0; turn < budget.maxTurns; turn++) {
    const url = `${GEMINI_API_URL}?key=${process.env.GEMINI_API_KEY}`;
    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents, tools: [{ functionDeclarations }] }),
      },
      budget.timeoutMs
    );
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
      const result = await runTool(call.functionCall.name, call.functionCall.args || {}, budget.timeoutMs, corpus);
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
  traits: {
    sourceUrlIdentifiesPerson: false,
    nameIsHandle: false,
    dataIsLLMExtracted: true,
    entityType: "person",
  },

  async search(jobSpec, options = {}) {
    if (!openWebAvailable()) return [];
    try {
      const budget = resolveBudget(options);
      const systemPrompt = buildSystemPrompt(jobSpec, budget.maxTurns);
      const backend = activeLLMProvider();
      const corpus = [];
      let found;
      if (backend === "anthropic") found = await runAnthropicLoop(systemPrompt, budget, corpus);
      else if (backend === "groq") found = await runGroqLoop(systemPrompt, budget, corpus);
      else found = await runGeminiLoop(systemPrompt, budget, corpus);

      const shaped = (Array.isArray(found) ? found : []).filter((f) => f && f.name && f.sourceUrl);

      const corpusText = corpus.join("\n");
      const grounded = [];
      for (const f of shaped) {
        if (nameWasSeen(f.name, corpusText)) {
          grounded.push(f);
        } else {
          console.warn(
            `[recruiter-ai] open_web dropped ungrounded candidate "${f.name}" (name not found in any page the agent read)`
          );
        }
      }

      const fieldsGrounded = grounded.map((f) => {
        const originalLocation = String(f.location || "").trim();
        const location = groundLocation(f.location, corpusText);
        if (originalLocation && !location) {
          console.warn(
            `[recruiter-ai] open_web ungrounded location dropped for "${f.name}" (not found in any page the agent read)`
          );
        }

        const originalSkills = Array.isArray(f.skills)
          ? f.skills.map((s) => String(s || "").trim()).filter(Boolean)
          : [];
        const skills = groundSkills(f.skills, corpusText);
        const droppedSkills = originalSkills.filter((s) => !skills.includes(s));
        if (droppedSkills.length > 0) {
          console.warn(
            `[recruiter-ai] open_web ungrounded skill(s) dropped for "${f.name}": ${droppedSkills.join(", ")}`
          );
        }

        return { ...f, location, skills };
      });

      return fieldsGrounded.slice(0, budget.maxCandidates).map((f, i) => toCandidate(f, jobSpec, i));
    } catch (err) {
      console.warn(`[recruiter-ai] open_web provider failed: ${err.message}`);
      return [];
    }
  },
};
