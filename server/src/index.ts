import express from "express";

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT ?? 4000);
const MODEL_API_KEY = process.env.MODEL_API_KEY ?? "";
const LLM_BASE_URL = process.env.LLM_BASE_URL ?? "";
const LLM_MODEL = process.env.LLM_MODEL ?? "";

app.get("/api/health", (_req, res) => {
  const missing: string[] = [];
  if (!MODEL_API_KEY) missing.push("MODEL_API_KEY");
  if (!LLM_BASE_URL) missing.push("LLM_BASE_URL");
  if (!LLM_MODEL) missing.push("LLM_MODEL");
  res.json({
    ok: true,
    provider: "meta",
    model: LLM_MODEL || null,
    llmConfigured: missing.length === 0,
    metaConfigured: missing.length === 0,
    envWarning: missing.length > 0 ? `Missing env vars: ${missing.join(", ")}` : null,
  });
});

app.listen(PORT, () => {
  console.log(`realitysync-server listening on :${PORT}`);
});
