# MCP server

`mcp-server.js` (repo root) exposes the same autonomous agent core used by
`POST /api/agent-search` as MCP tools, so the pipeline is drivable from an
MCP client (Claude Desktop, Claude Code, etc.) by conversation instead of the
browser. See `PLAN_V2.md` §5 Phase 6.

## What this is (and isn't)

- **Hand-rolled, minimal JSON-RPC 2.0 over stdio.** The project has a hard
  rule of zero new npm dependencies, so this does **not** use
  `@modelcontextprotocol/sdk`. It implements the wire protocol directly with
  Node built-ins (`readline` over `process.stdin`/`process.stdout`).
- **Tools capability only.** No resources, no prompts, no sampling. It
  answers `initialize` with `capabilities: { tools: {} }` and nothing else.
- **No duplicated logic.** The tools call straight into
  `lib/agent/orchestrate.js` (`agentSearch`), `lib/jobTemplates.js`, and
  `lib/providers/index.js` — the exact modules the HTTP routes use. There is
  no HTTP round-trip and no second implementation of the search/ranking
  logic.
- Every tool catches its own errors internally and returns them as text
  content with `isError: true` rather than throwing out of `tools/call`.

## Running it

```bash
node mcp-server.js
```

It reads newline-delimited JSON-RPC requests from stdin and writes
newline-delimited JSON-RPC responses to stdout. **Stdout carries only
JSON-RPC** — all diagnostics go to stderr, so a client that only reads
stdout never sees anything but valid protocol messages.

It needs the **same `.env`** the HTTP server uses (`GITHUB_TOKEN`,
`GROQ_API_KEY`/`ANTHROPIC_API_KEY`/`GEMINI_API_KEY`, `TAVILY_API_KEY`,
`GOOGLE_PLACES_API_KEY`, etc.) — it calls `dotenv.config()` itself on
startup, so run it from the repo root (or point your client's `cwd` there)
so `.env` resolves.

## Client configuration

Add an entry like this to your MCP client's config (e.g. Claude Desktop's
`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "recruiter-ai": {
      "command": "node",
      "args": ["/absolute/path/to/recruiter-ai/mcp-server.js"]
    }
  }
}
```

Use an absolute path to `mcp-server.js` — most MCP clients launch the
process with an unspecified working directory, and a relative path will
fail to resolve.

## Methods handled

| Method | Behavior |
| --- | --- |
| `initialize` | Returns `{ protocolVersion, capabilities: { tools: {} }, serverInfo }`. |
| `notifications/initialized` | Notification (no `id`) — acknowledged by doing nothing; no response is sent. |
| `tools/list` | Returns the 3 tool definitions below. |
| `tools/call` | Executes the named tool and returns `{ content: [{ type: "text", text }], isError? }`. |
| anything else, with an `id` | JSON-RPC error `-32601 Method not found`. |
| anything else, without an `id` | Silently ignored (JSON-RPC notifications are never responded to). |

Malformed JSON on a line gets a `-32700 Parse error` response with `id:
null`; an exception inside request handling gets `-32603 Internal error`
with the original request's `id` (never a crash, never an unhandled
rejection).

## Tools

### `search_candidates`

The headline tool. Builds a `JobSpec`, runs the full `agentSearch()`
pipeline (autonomous source selection → fan-out → dedupe → score →
consolidate → trim to `topN`), and returns a **human-readable text summary**
— ranked candidates with name, `agentRank1to10`, `sourceTrust`, `source`,
`sourceUrl`, plus which sources were queried and how they did — not a raw
JSON dump.

Input schema:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `field` | string | yes | e.g. `"software"`, `"finance"`, `"healthcare"`. |
| `title` | string | no | Matched against a built-in template for the given field when it matches exactly (see `list_job_templates`). |
| `location` | string | no | e.g. `"Delhi"`. Also unlocks location-anchored sources (Google Places, OpenStreetMap). |
| `skills` | string[] | no | Required skills/keywords; merged into (or added onto) the template's skills criterion. |
| `minYears` | number | no | Minimum years of experience; merged into (or added onto) the template's experience criterion. |
| `topN` | number | no | How many ranked candidates to return. Defaults to `5`. |

JobSpec construction: if `field` (and `title`, when given) matches a
built-in template in `lib/jobTemplates.js`, that template's criteria are
used as the starting point, with any explicit `skills`/`minYears`
overriding or extending it. Otherwise criteria are synthesized directly from
whatever was given, falling back to a generic keyword criterion if nothing
else was specified, so the JobSpec is never criteria-less.

**Scoring is always rules-based here (`useLLM: false` is forced), and the
LLM source-refinement pass is skipped** — this schema doesn't expose an LLM
toggle, and a synchronous chat-tool call shouldn't default to something
slower and rate-limit-fragile. This does **not** disable `open_web`: that
source is still included by the deterministic baseline whenever an LLM key
+ `TAVILY_API_KEY` are configured, and it runs its own bounded agentic loop
against whichever LLM backend is active, independent of this flag.

### `list_fields`

No input. Returns the supported fields and which registered providers serve
each — the same data `GET /api/fields` returns, as text.

### `list_job_templates`

No input. Returns the built-in `JOB_TEMPLATES` (field, title, and each
criterion's key/weight/requirements), grouped by field.

## Verification (manual, no MCP client required)

Driven by hand over stdin/stdout with a temporary script that spawned `node
mcp-server.js` and sent `initialize` → `notifications/initialized` →
`tools/list` → a `tools/call` for `search_candidates` with
`{ field: "finance", location: "Delhi", topN: 3 }`. Confirmed:

- All 3 requests got a valid JSON-RPC response with the matching `id`
  echoed back (`1`, `2`, `3`); the notification got none.
- `tools/list` returned exactly the 3 tools documented above with their
  schemas.
- The `search_candidates` call returned **real candidates** — 3 real SEBI
  Registered Investment Advisers based in Delhi/NCT Delhi, each with a name,
  a `VERIFIED` trust badge, a data-completeness percentage, and a real
  `sebi.gov.in` `sourceUrl` — built from a synthesized "Accountant"
  JobSpec (finance's first built-in template, since no `title` was given),
  with `sourcePlan` querying `sebi_ria`, `finra`, `osm`, and `open_web`
  (`sebi_ria`: 25 found, `finra`: 8, `osm`: 0 — hit a live `429` from the
  Overpass API, logged to stderr and handled gracefully as a zero-candidate
  `ok` result, not a crash — `open_web`: 0).
- `scoredBy: "rules"` in the response text, confirming `useLLM: false` was
  honored (no LLM scoring call made).
- **Nothing but valid JSON appeared on stdout** across all 3 responses; the
  live `429` and a "server ready" line both went to stderr only.
- `node --check mcp-server.js` passed, and the full suite
  (`npm test`) stayed green at 128/128 with `mcp-server.js` added — this
  file is exercised only by the manual protocol probe above, not by the
  `node:test` suite.
