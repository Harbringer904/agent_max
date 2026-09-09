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

const PERSON_SIGNALS = ["proprietor", "sole proprietor", "individual", "founder of", "prop."];

/**
 * Strip a trailing firm suffix so "<PERSON> - Proprietor <FIRM>" can be judged
 * on the human part alone. Returns the original string when no marker is found.
 */
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

  if (PERSON_SIGNALS.some((sig) => raw.toLowerCase().includes(sig))) {
    const person = personPartOf(raw);
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
