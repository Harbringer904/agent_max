// lib/providers/stackoverflow.js
//
// Stack Overflow provider — searches the free Stack Exchange API (no key
// required for low volume) for top answerers on a tag derived from the
// jobSpec's 'skills' criterion, and maps them to unified Candidates.
//
// Exports:
//   provider   { key:"stackoverflow", label:"Stack Overflow", fields:["software"], search(jobSpec, options) }

import { normalizeCandidate } from "../normalize.js";

const API_BASE = "https://api.stackexchange.com/2.3";
const SITE = "stackoverflow";
const TIMEOUT_MS = 15_000;
const MAX_CANDIDATES = 15;
const TOP_ANSWERERS_PAGESIZE = 20;

// Best-effort mapping from common skill names (as recruiters type them) to
// the Stack Overflow tag that actually exists on the site.
const SKILL_TO_TAG = {
  javascript: "javascript",
  js: "javascript",
  typescript: "typescript",
  ts: "typescript",
  python: "python",
  react: "reactjs",
  "react.js": "reactjs",
  reactjs: "reactjs",
  "node.js": "node.js",
  node: "node.js",
  nodejs: "node.js",
  vue: "vue.js",
  "vue.js": "vue.js",
  angular: "angular",
  java: "java",
  "c#": "c#",
  csharp: "c#",
  "c++": "c++",
  cpp: "c++",
  c: "c",
  go: "go",
  golang: "go",
  ruby: "ruby",
  php: "php",
  swift: "swift",
  kotlin: "kotlin",
  rust: "rust",
  sql: "sql",
  html: "html",
  html5: "html",
  css: "css",
  css3: "css",
  docker: "docker",
  kubernetes: "kubernetes",
  aws: "amazon-web-services",
  azure: "azure",
  gcp: "google-cloud-platform",
  django: "django",
  flask: "flask",
  spring: "spring",
  ".net": ".net",
  dotnet: ".net",
  "r": "r",
  scala: "scala",
  perl: "perl",
  "objective-c": "objective-c",
};

/** Map a raw skill string to a Stack Overflow tag slug. */
function skillToTag(skill) {
  const s = String(skill || "").trim().toLowerCase();
  if (!s) return null;
  if (SKILL_TO_TAG[s]) return SKILL_TO_TAG[s];
  // Fall back to a slug guess: spaces -> hyphens.
  return s.replace(/\s+/g, "-");
}

/** Derive the primary SO tag from the jobSpec's 'skills' criterion. */
function primaryTag(jobSpec) {
  const skillsCriterion = (jobSpec?.criteria || []).find((c) => c.key === "skills");
  const requiredSkills = skillsCriterion?.requiredSkills || [];
  for (const skill of requiredSkills) {
    const tag = skillToTag(skill);
    if (tag) return tag;
  }
  return null;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Stack Exchange API ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Strip HTML tags and decode a few common entities from about_me. */
function stripHtml(html) {
  if (!html) return null;
  const text = String(html)
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

/** Whole years since a Stack Overflow account was created. */
function yearsSinceCreation(creationDateSeconds) {
  if (!creationDateSeconds) return null;
  const ms = Date.now() - creationDateSeconds * 1000;
  return Math.max(0, Math.floor(ms / (365.25 * 24 * 60 * 60 * 1000)));
}

function toCandidate(user, tag, index) {
  return normalizeCandidate(
    {
      id: `stackoverflow:${user.user_id}`,
      name: user.display_name,
      headline: `Stack Overflow — ${user.reputation ?? 0} rep`,
      field: "software",
      location: user.location ?? null,
      yearsExperience: yearsSinceCreation(user.creation_date),
      education: null,
      educationLevel: null,
      skills: [tag],
      certifications: [],
      summary: stripHtml(user.about_me),
      sourceUrl: user.link ?? null,
      avatarUrl: user.profile_image ?? null,
      raw: {
        reputation: user.reputation ?? 0,
        badge_counts: user.badge_counts ?? {},
        user_id: user.user_id,
      },
    },
    "stackoverflow",
    index
  );
}

export const provider = {
  key: "stackoverflow",
  label: "Stack Overflow",
  fields: ["software"],

  async search(jobSpec, _options = {}) {
    try {
      const tag = primaryTag(jobSpec);
      if (!tag) return [];

      const topAnswerersUrl =
        `${API_BASE}/tags/${encodeURIComponent(tag)}/top-answerers/all_time` +
        `?site=${SITE}&pagesize=${TOP_ANSWERERS_PAGESIZE}`;
      const topAnswerersData = await fetchJson(topAnswerersUrl);
      const items = Array.isArray(topAnswerersData?.items) ? topAnswerersData.items : [];

      const userIds = [
        ...new Set(items.map((item) => item?.user?.user_id).filter((id) => Number.isFinite(id))),
      ].slice(0, MAX_CANDIDATES);
      if (userIds.length === 0) return [];

      const usersUrl = `${API_BASE}/users/${userIds.join(";")}?site=${SITE}&filter=default`;
      const usersData = await fetchJson(usersUrl);
      const users = Array.isArray(usersData?.items) ? usersData.items : [];

      return users.slice(0, MAX_CANDIDATES).map((user, i) => toCandidate(user, tag, i));
    } catch (err) {
      console.warn(`[recruiter-ai] Stack Overflow provider failed: ${err.message}`);
      return [];
    }
  },
};
