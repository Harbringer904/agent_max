# API Error Codes

All user-facing API errors follow the opaque shape:

```json
{ "error": "<generic message> (Rxxx)" }
```

The message text is intentionally generic and must never reveal internals (stack traces,
file paths, provider error text, etc.). This file is the **only** place the real meaning
of each code is documented. Prefix `R` = recruiter-ai routes.

| Code | HTTP status | Meaning                                                                 | Lives in              |
| ---- | ----------- | ------------------------------------------------------------------------ | ---------------------- |
| R001 | 400         | `jobSpec` is missing or malformed — must be an object with a non-empty string `field` and a non-empty `criteria` array whose items each have a string `key` and a numeric `weight`. | `routes/search.js`, `routes/results.js`, `routes/agentSearch.js` |
| R002 | 400         | `provider` is missing or not a recognized provider key (see `lib/providers/index.js`). | `routes/search.js`     |
| R003 | 400         | `candidates` is missing, not an array, or empty — a result set must contain at least one candidate to be saved. | `routes/results.js`    |
| R004 | 404         | No saved result exists for the requested id (unknown id, or it never passed the id format check). | `routes/results.js`    |
| R500 | 500         | Unhandled error while processing the request (provider/network failure, unexpected exception, etc.). The real error is logged server-side via `console.error`, never returned to the client. | `routes/search.js`, `routes/results.js`, `routes/agentSearch.js` |

`POST /api/agent-search` (`routes/agentSearch.js`) has no `provider` field in its request body — source selection is autonomous (see `lib/agent/plan.js` and `PLAN_V2.md`), so R002 does not apply there.
