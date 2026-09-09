import { normalizeCandidate } from "../normalize.js";

const API_BASE = "https://dev.to/api/articles";
const TIMEOUT_MS = 15_000;
const MAX_CANDIDATES = 15;
const PER_PAGE = 30;

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Dev.to API ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function skillToTag(skill) {
  const s = String(skill || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return s || null;
}

function primaryTag(jobSpec) {
  const requiredSkills = (jobSpec?.criteria || []).find((c) => c.key === "skills")?.requiredSkills || [];
  for (const skill of requiredSkills) {
    const tag = skillToTag(skill);
    if (tag) return tag;
  }
  return null;
}

function toCandidate(author, index) {
  const skills = [...author.tagSet].slice(0, 10);
  const titles = author.articles.map((a) => a.title).slice(0, 5);

  return normalizeCandidate(
    {
      id: `devto:${author.username}`,
      name: author.name || author.username,
      headline: `Dev.to author — ${author.articles.length} post${author.articles.length === 1 ? "" : "s"}`,
      field: "software",
      location: null,
      yearsExperience: null,
      education: null,
      educationLevel: null,
      skills,
      certifications: [],
      summary: titles.join(" | ") || null,
      sourceUrl: `https://dev.to/${author.username}`,
      avatarUrl: author.profileImage || null,
      raw: {
        username: author.username,
        websiteUrl: author.websiteUrl || null,
        articleCount: author.articles.length,
      },
    },
    "devto",
    index
  );
}

export const provider = {
  key: "devto",
  label: "Dev.to",
  fields: ["software"],
  traits: {
    sourceUrlIdentifiesPerson: true,
    nameIsHandle: true,
    dataIsLLMExtracted: false,
    entityType: "person",
  },

  async search(jobSpec, _options = {}) {
    try {
      const tag = primaryTag(jobSpec);
      if (!tag) return [];

      const url = `${API_BASE}?tag=${encodeURIComponent(tag)}&per_page=${PER_PAGE}`;
      const articles = await fetchJson(url);
      if (!Array.isArray(articles) || articles.length === 0) return [];

      const authors = new Map();
      for (const article of articles) {
        const user = article?.user;
        const username = user?.username;
        if (!username) continue;

        if (!authors.has(username)) {
          authors.set(username, {
            username,
            name: user.name || null,
            websiteUrl: user.website_url || null,
            profileImage: user.profile_image || null,
            tagSet: new Set(),
            articles: [],
          });
        }
        const author = authors.get(username);
        author.articles.push({ title: article.title });
        for (const t of article.tag_list || []) {
          if (t) author.tagSet.add(t);
        }
      }

      return [...authors.values()].slice(0, MAX_CANDIDATES).map((author, i) => toCandidate(author, i));
    } catch (err) {
      console.warn(`[recruiter-ai] Dev.to provider failed: ${err.message}`);
      return [];
    }
  },
};
