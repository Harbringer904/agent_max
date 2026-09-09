import express from "express";
import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";

import { hasToken } from "./lib/providers/github.js";

import healthRouter from "./routes/health.js";
import fieldsRouter from "./routes/fields.js";
import templatesRouter from "./routes/templates.js";
import searchRouter from "./routes/search.js";
import agentSearchRouter from "./routes/agentSearch.js";
import agentJobsRouter from "./routes/agentJobs.js";
import resultsRouter from "./routes/results.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.use("/api/health", healthRouter);
app.use("/api/fields", fieldsRouter);
app.use("/api/templates", templatesRouter);
app.use("/api/search", searchRouter);
app.use("/api/agent-search", agentSearchRouter);
app.use("/api/agent-search/jobs", agentJobsRouter);
app.use("/api/results", resultsRouter);

app.listen(PORT, () => {
  console.log(`\n  🚀 agent_max running at http://localhost:${PORT}`);
  console.log(
    `  📡 GitHub API: ${hasToken() ? "authenticated (5000 req/hr)" : "unauthenticated (60 req/hr — add GITHUB_TOKEN for more)"}\n`
  );
});
