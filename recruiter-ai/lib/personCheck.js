// lib/personCheck.js
//
// Is this "candidate" name actually an individual person, or an organization?
//
// WHY THIS IS SHARED (docs/DATA_QUALITY_PLAN.md P3):
// This heuristic was written inline in openalex.js after that provider was found
// returning 20 of 20 non-people — "CYPHER Workshop on Machine Learning",
// "UCI Machine Learning Repository", "Institute for Machine Learning". A
// recruiting tool must never present a conference as a hireable candidate. Any
// provider that claims to return people can hit the same class of problem, so
// the check lives here rather than in one provider.
//
// DELIBERATE BIAS: tuned to over-reject rather than under-reject. A dropped real
// person is recoverable (they surface via another source, or a looser query); a
// conference presented as a candidate is a credibility failure a recruiter may
// act on. This tradeoff is documented in FAIRNESS.md.
//
// Exports:
//   ORG_TOKENS             the token list, exported so tests/doctor can inspect it
//   looksLikeOrganization(name) -> boolean

// Tokens that mark a name as an entity rather than a human.
export const ORG_TOKENS = Object.freeze([
  "university", "institute", "institut", "college", "school", "academy",
  "laboratory", "laboratoire", "lab", "labs", "center", "centre", "department",
  "faculty", "hospital", "clinic", "foundation", "society", "association",
  "committee", "subcommittee", "council", "consortium", "network", "group",
  "team", "workshop", "conference", "symposium", "seminar", "congress",
  "proceedings", "journal", "repository", "dataset", "database", "project",
  "program", "programme", "initiative", "collaboration", "working party",
  "ltd", "llc", "inc", "gmbh", "s.l.", "corporation", "company", "agency",
  "ministry", "government", "authority", "bureau", "office", "division",
  "unit", "research group", "study group", "trial", "cohort", "biobank",
  "solutions", "services", "partners", "associates", "holdings", "ventures",
]);

// Words that positively mark a NATURAL PERSON even when a firm name is
// appended. Verified live against the SEBI registry, which lists sole
// proprietors as "<PERSON> - Proprietor <FIRM>" / "<PERSON> PROPRIETOR OF
// <FIRM>". Without this override the org-token rule rejected real advisers:
//   "Abhishek Phore - Proprietor Control Wealth Advisers"
//   "KUSHAL BHATEJA PROPRIETOR OF FINCLIN INVESTMENT ADVISORS"
// Both are individual people. A sole proprietorship IS a natural person
// legally, so these must not be filtered out as organizations.
const PERSON_SIGNALS = ["proprietor", "sole proprietor", "individual", "founder of", "prop."];

/** Strip a trailing firm suffix so "<PERSON> - Proprietor <FIRM>" can be judged
 * on the human part alone. Returns the original string when no marker is found. */
export function personPartOf(name) {
  const s = String(name || "").trim();
  const m = s.match(/^(.*?)[\s,-]*\b(?:sole\s+)?prop(?:rietor)?\.?\b(?:\s+of\b)?/i);
  const head = m && m[1] ? m[1].trim() : "";
  return head || s;
}

/**
 * True when `name` looks like an organization/event/dataset rather than a person.
 *
 * Signals, any one of which is disqualifying:
 *  - contains an organization token as a whole word
 *  - more than 5 whitespace-separated words (people rarely have 6+ word names;
 *    entities routinely do)
 *  - contains "&", "/", parentheses, or a run of 2+ digits
 *  - is empty/blank (nothing to verify -> not a usable candidate)
 *
 * EXCEPT: a PERSON_SIGNALS marker (e.g. "Proprietor") means a real human is
 * named, with their firm appended — judge only the human part.
 */
export function looksLikeOrganization(name) {
  const raw = String(name || "").trim();
  if (!raw) return true;

  // Sole proprietors: evaluate just the person's name, not the trailing firm.
  if (PERSON_SIGNALS.some((sig) => raw.toLowerCase().includes(sig))) {
    const person = personPartOf(raw);
    // A marker with no name in front of it ("Proprietor of X") is not a person.
    if (!person || person.toLowerCase() === raw.toLowerCase()) return true;
    return looksLikeOrganization(person);
  }

  const n = raw;
  const lower = n.toLowerCase();
  if (ORG_TOKENS.some((t) => new RegExp(`(^|[^a-z])${t.replace(/\./g, "\\.")}([^a-z]|$)`, "i").test(lower))) {
    return true;
  }
  if (n.split(/\s+/).length > 5) return true;
  if (/[&/()]|\d{2,}/.test(n)) return true;
  return false;
}
