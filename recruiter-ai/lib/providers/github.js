// lib/providers/github.js
//
// GitHub provider — searches GitHub users and maps them to unified Candidates.
// The ONLY file in the project that performs network I/O against GitHub.
// Refactored from the former lib/githubClient.js into the Provider interface;
// the working search/backoff/rate-limit logic is unchanged.
//
// Exports:
//   provider     { key:"github", label:"GitHub", fields:["software"], search(jobSpec, options) }
//   hasToken()   boolean — whether a GITHUB_TOKEN is configured

import dotenv from "dotenv";
import { normalizeCandidate } from "../normalize.js";

dotenv.config();

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "recruiter-ai";
const TOKEN = process.env.GITHUB_TOKEN?.trim() || null;

const MAX_RETRIES = 5;
const MAX_BACKOFF_MS = 60_000;

let warnedNoToken = false;

export function hasToken() {
  return Boolean(TOKEN);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildHeaders() {
  const h = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": USER_AGENT,
  };
  if (TOKEN) {
    h.Authorization = `Bearer ${TOKEN}`;
  } else if (!warnedNoToken) {
    console.warn(
      "[recruiter-ai] No GITHUB_TOKEN — rate limits will be very low (60/hr)."
    );
    warnedNoToken = true;
  }
  return h;
}

// Throttle search endpoint (10 req/min unauth, 30 auth)
let lastSearchAt = 0;
async function throttleSearch() {
  const rpm = TOKEN ? 30 : 10;
  const gap = Math.ceil(60_000 / rpm);
  const elapsed = Date.now() - lastSearchAt;
  if (lastSearchAt && elapsed < gap) await sleep(gap - elapsed);
  lastSearchAt = Date.now();
}

async function githubFetch(path, { context = path } = {}) {
  const url = path.startsWith("http") ? path : `${GITHUB_API}${path}`;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: buildHeaders() });
    } catch (err) {
      if (attempt >= MAX_RETRIES)
        throw new Error(`Network error (${context}): ${err.message}`);
      await sleep(Math.min(MAX_BACKOFF_MS, 2 ** attempt * 1000));
      continue;
    }
    if (res.status === 403 || res.status === 429) {
      if (attempt >= MAX_RETRIES) {
        const body = await res.text().catch(() => "");
        throw new Error(`Rate limited (${res.status}) for ${context}: ${body.slice(0, 200)}`);
      }
      const retryAfter = res.headers.get("retry-after");
      const reset = res.headers.get("x-ratelimit-reset");
      let waitMs = 2 ** attempt * 1000;
      if (retryAfter) waitMs = Number(retryAfter) * 1000;
      else if (res.headers.get("x-ratelimit-remaining") === "0" && reset)
        waitMs = Number(reset) * 1000 - Date.now();
      waitMs = Math.min(MAX_BACKOFF_MS, Math.max(1000, waitMs));
      console.warn(`[recruiter-ai] Rate limited on ${context}, waiting ${Math.round(waitMs / 1000)}s`);
      await sleep(waitMs);
      continue;
    }
    if (res.status === 404) throw Object.assign(new Error(`Not found: ${context}`), { status: 404 });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GitHub API ${res.status} for ${context}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }
}

async function searchUsers(query, { limit = 25 } = {}) {
  if (!query?.trim()) throw new Error("searchUsers: query required");
  const target = Math.max(1, Math.min(limit, 100));
  const perPage = Math.min(100, target);
  const logins = [];
  let page = 1;
  while (logins.length < target) {
    await throttleSearch();
    const q = encodeURIComponent(query.trim());
    const data = await githubFetch(`/search/users?q=${q}&per_page=${perPage}&page=${page}`, {
      context: `search p${page}`,
    });
    const items = Array.isArray(data.items) ? data.items : [];
    for (const item of items) {
      if (item?.login && item.type !== "Organization") logins.push(item.login);
    }
    if (items.length < perPage) break;
    page++;
    if (page > 10) break;
  }
  return logins.slice(0, target);
}

async function getUserTopLanguages(username, max = 8) {
  try {
    const repos = await githubFetch(
      `/users/${encodeURIComponent(username)}/repos?per_page=100&sort=pushed&type=owner`,
      { context: `repos:${username}` }
    );
    if (!Array.isArray(repos)) return [];
    const counts = new Map();
    for (const repo of repos) {
      if (repo?.fork) continue;
      if (repo?.language) counts.set(repo.language, (counts.get(repo.language) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, max)
      .map(([lang]) => lang);
  } catch {
    return [];
  }
}

/** Whole years since the GitHub account was created — a proxy for experience. */
function yearsSinceAccountCreated(isoDate) {
  if (!isoDate) return null;
  const created = new Date(isoDate);
  if (Number.isNaN(created.getTime())) return null;
  const ms = Date.now() - created.getTime();
  return Math.max(0, Math.floor(ms / (365.25 * 24 * 60 * 60 * 1000)));
}

async function getUserProfile(username) {
  const raw = await githubFetch(`/users/${encodeURIComponent(username)}`, {
    context: `user:${username}`,
  });
  const topLanguages = await getUserTopLanguages(raw.login);
  return { raw, topLanguages };
}

function toCandidate(raw, topLanguages, index) {
  const name = raw.name || raw.login;
  const bio = raw.bio ?? null;
  return normalizeCandidate(
    {
      id: `github:${raw.login}`,
      name,
      headline: bio || name,
      field: "software",
      location: raw.location ?? null,
      yearsExperience: yearsSinceAccountCreated(raw.created_at),
      education: null,
      educationLevel: null,
      skills: topLanguages,
      certifications: [],
      summary: bio,
      sourceUrl: raw.html_url ?? `https://github.com/${raw.login}`,
      avatarUrl: raw.avatar_url ?? null,
      raw: { ...raw, topLanguages },
    },
    "github",
    index
  );
}

/** Derive a GitHub search query from the jobSpec's 'skills' criterion + location. */
function buildQuery(jobSpec, options = {}) {
  const parts = [];
  const skillsCriterion = (jobSpec?.criteria || []).find((c) => c.key === "skills");
  const requiredSkills = skillsCriterion?.requiredSkills || [];
  for (const skill of requiredSkills) {
    const s = String(skill).trim();
    if (s) parts.push(`language:${s}`);
  }
  const location = (options.location ?? jobSpec?.location) || "";
  if (location.trim()) {
    const loc = location.trim();
    parts.push(loc.includes(" ") ? `location:"${loc}"` : `location:${loc}`);
  }
  parts.push("type:user");
  return parts.join(" ");
}

export const provider = {
  key: "github",
  label: "GitHub",
  fields: ["software"],

  async search(jobSpec, options = {}) {
    const query = buildQuery(jobSpec, options);
    const limit = Math.min(options.maxResults || 15, 30);

    const logins = await searchUsers(query, { limit });

    const candidates = [];
    let i = 0;
    for (const login of logins) {
      try {
        const { raw, topLanguages } = await getUserProfile(login);
        candidates.push(toCandidate(raw, topLanguages, i++));
      } catch (err) {
        console.warn(`Skipping ${login}: ${err.message}`);
      }
    }
    return candidates;
  },
};
