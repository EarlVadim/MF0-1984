/**
 * MF0-1984 API entry point.
 * Thin Express bootstrap: middleware → routers → listen.
 * All route logic lives in server/routes/*.mjs.
 */
import express from "express";
import { resolveApiPort } from "./resolveApiPort.mjs";
import { dbPath } from "./db/migrations.mjs";
import { normalizePathname, securityHeaders, notFound, errorHandler } from "./middleware/http.mjs";
import { MAX_BODY_BYTES } from "./config.mjs";

import healthRouter from "./routes/health.mjs";
import attachmentsRouter from "./routes/attachments.mjs";
import voiceRouter from "./routes/voice.mjs";
import purposeSessionsRouter from "./routes/purposeSessions.mjs";
import accessRouter from "./routes/access.mjs";
import settingsRouter from "./routes/settings.mjs";
import irPanelLockRouter from "./routes/irPanelLock.mjs";
import memoryGraphRouter from "./routes/memoryGraph.mjs";
import projectProfileRouter from "./routes/projectProfile.mjs";
import analyticsRouter from "./routes/analytics.routes.mjs";
import themesRouter from "./routes/themes.mjs";
import llmRouter     from "./routes/llm.mjs";
import localfsRouter  from "./routes/localfs.mjs";
import authRouter     from "./routes/auth.mjs";
import maestroRouter   from "./routes/maestro.mjs";
import { attachSession } from "./middleware/auth.mjs";
import { startScheduler } from "./services/maestroScheduler.mjs";
import { setSchedulerRunning } from "./services/maestro.mjs";

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openRouterModelPriceMap } from "./db/openrouterPrices.mjs";

// ── Load OpenRouter per-model prices at startup ───────────────────────────────
(function loadOpenRouterPrices() {
  try {
    const __dir = dirname(fileURLToPath(import.meta.url));
    const file = resolve(__dir, "../openrouter-models.txt");
    if (!existsSync(file)) return;
    const raw = readFileSync(file, "utf-8");
    raw.split(/\r?\n/).forEach((line) => {
      const l = line.trim();
      if (!l || l.startsWith("#")) return;
      const parts = l.split("|").map((p) => p.trim());
      const id = parts[0];
      if (!id) return;
      const inputPer1M  = parseFloat(parts[1] ?? "0") || 0;
      const outputPer1M = parseFloat(parts[2] ?? "0") || 0;
      const shortName = parts.length > 3 && parts[3]
        ? parts[3].trim()
        : (id.split("/").pop() || id);
      openRouterModelPriceMap.set(id, { inputPer1M, outputPer1M, shortName });
    });
    console.log(`[mf-lab-api] OpenRouter prices loaded: ${openRouterModelPriceMap.size} model(s)`);
  } catch (e) {
    console.warn("[mf-lab-api] Could not load openrouter-models.txt:", e?.message);
  }
})();

const PORT = resolveApiPort(process.env.API_PORT);
const app = express();

// Strip API_PATH_PREFIX (reverse-proxy path rewriting)
const apiPrefix = process.env.API_PATH_PREFIX ? normalizePathname(process.env.API_PATH_PREFIX) : "";
if (apiPrefix) {
  app.use((req, _res, next) => {
    if (req.url.startsWith(apiPrefix)) req.url = req.url.slice(apiPrefix.length) || "/";
    next();
  });
}

app.use(securityHeaders);

// Session hydration — attaches req.user to every request (null if not logged in)
app.use(attachSession);
// JSON parser for all /api routes (binary routes apply their own express.raw() inline).
// Accepts both application/json and text/json (memory-graph import sends text/json in some clients).
app.use("/api", express.json({ limit: MAX_BODY_BYTES, type: ["application/json", "text/json"] }));

// Ensure req.body is always at least {} after the JSON parser
app.use("/api", (req, _res, next) => { req.body = req.body ?? {}; next(); });

app.use("/api", authRouter);
app.use("/api", healthRouter);
app.use("/api", attachmentsRouter);
app.use("/api", voiceRouter);
app.use("/api", purposeSessionsRouter);
app.use("/api", accessRouter);
app.use("/api", settingsRouter);
app.use("/api", irPanelLockRouter);
app.use("/api", memoryGraphRouter);
app.use("/api", projectProfileRouter);
app.use("/api", analyticsRouter);
app.use("/api", themesRouter);
app.use("/api", llmRouter);
app.use("/api", localfsRouter);
app.use("/api", maestroRouter);

app.use(notFound);
app.use(errorHandler);

app.listen(PORT, "127.0.0.1", () => {
  console.log(`MF0-1984 API http://127.0.0.1:${PORT}/ (SQLite: ${dbPath})`);
  if (apiPrefix) console.log(`[mf-lab-api] API_PATH_PREFIX=${process.env.API_PATH_PREFIX}`);

  // Auto-start Maestro scheduler unless explicitly disabled
  if (String(process.env.MAESTRO_SCHEDULER_DISABLED ?? "").trim() !== "1") {
    try {
      startScheduler();
      setSchedulerRunning(true);
      console.log("[mf-lab-api] Maestro scheduler auto-started");
    } catch (e) {
      console.warn("[mf-lab-api] Maestro scheduler failed to start:", e?.message);
    }
  }
});
