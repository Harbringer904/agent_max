// lib/providers/hnHiring.js
//
// Hacker News "Who wants to be hired?" provider — the highest-intent source
// in the app: every person here posted, in the current or most recent
// monthly thread, that they are actively looking for work right now.
// Free, no-key Algolia HN Search API.
//
// Two-step lookup:
//   1. search_by_date for "Who wants to be hired" story threads, pick the
//      newest one whose title matches /^Ask HN: Who wants to be hired\?/i.
//   2. fetch that thread's items (top-level children = individual posts) and
//      parse each post's loosely-structured text.
//
// Exports:
//   provider   { key:"hn_hiring", label, fields:["software"], search(jobSpec, options) }

import { normalizeCandidate } from "../normalize.js";

const SEARCH_URL =
  "https://hn.algolia.com/api/v1/search_by_date?query=Who%20wants%20to%20be%20hired&tags=story&hitsPerPage=5";
const ITEM_URL = (id) => `https://hn.algolia.com/api/v1/items/${id}`;
const THREAD_TITLE_RE = /^Ask HN: Who wants to be hired\?/i;

const TIMEOUT_MS = 15_000;
const MAX_CANDIDATES = 20;

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HN Algolia API ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Decode the common HTML entities Algolia/HN text shows up with. */
function decodeEntities(str) {
  return String(str || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}

/**
 * Convert a post's raw HTML text into plain text. HN "paragraphs" are
 * separated by bare <p> tags (not wrapping pairs), which is also how these
 * posts delimit their "Field: value" lines, so we turn those into newlines
 * before stripping remaining tags — this keeps field extraction reliable
 * whether a poster put one field per line or ran them together.
 */
function htmlToLines(html) {
  if (!html) return "";
  let text = String(html).replace(/<\/?(p|br)\s*\/?>/gi, "\n");
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeEntities(text);
  text = text.replace(/[ \t]+/g, " ").replace(/\n\s*/g, "\n").trim();
  return text;
}

/** Single-line, whitespace-collapsed version for summaries. */
function htmlToPlainText(html) {
  return htmlToLines(html).replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
}

const FIELD_LABELS = [
  "location",
  "remote",
  "willing to relocate",
  "willingness to relocate",
  "email",
  "technologies",
  "tech stack",
  "stack",
  "tech",
  "résumé\\/cv",
  "resume\\/cv",
  "résumé",
  "resume",
  "cv",
];
const STOP_BOUNDARY = FIELD_LABELS.join("|");

/** Tolerant "Label: value" extractor — value runs to end-of-line or the next
 * recognized field label, whichever comes first (handles posts that cram
 * every field onto a single line). */
function extractField(text, labelPattern) {
  const re = new RegExp(
    `\\b(?:${labelPattern})\\s*:\\s*([^\\n]*?)(?=\\s*(?:\\n|(?:${STOP_BOUNDARY})\\s*:)|$)`,
    "i"
  );
  const m = text.match(re);
  if (!m) return null;
  const val = m[1].trim();
  return val || null;
}

/** Best-effort "N years [of] ... experience" — returns null rather than
 * guessing when no such phrase is present. */
function extractYears(text) {
  const m = text.match(/\b(\d{1,2})\+?\s*years?\b(?:\s+of)?\s*(?:professional\s+)?experience/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function parseSkills(techField) {
  if (!techField) return [];
  return techField
    .split(/[,/]|(?:\s+and\s+)/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

function toCandidate(child, threadId, index) {
  const plain = htmlToLines(child.text);

  const location = extractField(plain, "location");
  const remote = extractField(plain, "remote");
  const willingToRelocate = extractField(
    plain,
    "willing to relocate|willingness to relocate"
  );
  const email = extractField(plain, "email");
  const techField = extractField(plain, "technologies|tech stack|stack|tech");
  const resumeUrl = extractField(
    plain,
    "résumé\\/cv|resume\\/cv|résumé|resume|cv"
  );

  const summary = htmlToPlainText(child.text).slice(0, 300) || null;

  return normalizeCandidate(
    {
      id: `hn_hiring:${child.id}`,
      name: child.author,
      headline: `Open to work${remote ? ` — Remote: ${remote}` : ""}`,
      field: "software",
      location,
      yearsExperience: extractYears(plain),
      education: null,
      educationLevel: null,
      skills: parseSkills(techField),
      certifications: [],
      summary,
      sourceUrl: `https://news.ycombinator.com/item?id=${child.id}`,
      avatarUrl: null,
      raw: {
        hnAuthor: child.author,
        remote,
        willingToRelocate,
        email,
        resumeUrl,
        threadId,
      },
    },
    "hn_hiring",
    index
  );
}

export const provider = {
  key: "hn_hiring",
  label: "HN: Who Wants To Be Hired",
  fields: ["software"],
  traits: {
    // news.ycombinator.com/item?id=<commentId> is unique per post/poster —
    // see the normalizeUrl() header note in lib/agent/dedupe.js for the real
    // bug this identity depends on (the query string must be kept).
    sourceUrlIdentifiesPerson: true,
    // `name` is always the raw HN username (child.author), never a real name.
    nameIsHandle: true,
    dataIsLLMExtracted: false,
    entityType: "person",
  },

  async search(jobSpec, _options = {}) {
    try {
      const searchData = await fetchJson(SEARCH_URL);
      const hits = Array.isArray(searchData?.hits) ? searchData.hits : [];
      const threadHits = hits
        .filter((h) => THREAD_TITLE_RE.test(h?.title || ""))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      const thread = threadHits[0];
      if (!thread) return [];

      const itemData = await fetchJson(ITEM_URL(thread.objectID));
      const children = Array.isArray(itemData?.children) ? itemData.children : [];
      const posts = children.filter((c) => c && typeof c.text === "string" && c.text.trim());
      if (posts.length === 0) return [];

      const requiredSkills =
        (jobSpec?.criteria || []).find((c) => c.key === "skills")?.requiredSkills || [];

      let ordered = posts;
      if (requiredSkills.length > 0) {
        const matches = [];
        const rest = [];
        for (const post of posts) {
          const hay = post.text.toLowerCase();
          const hit = requiredSkills.some((skill) => hay.includes(String(skill).toLowerCase()));
          (hit ? matches : rest).push(post);
        }
        ordered = [...matches, ...rest];
      }

      return ordered
        .slice(0, MAX_CANDIDATES)
        .map((child, i) => toCandidate(child, thread.objectID, i));
    } catch (err) {
      console.warn(`[recruiter-ai] HN Who Wants To Be Hired provider failed: ${err.message}`);
      return [];
    }
  },
};
