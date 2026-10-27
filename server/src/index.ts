import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import { dbBackend, initDb, type Db } from "./db.js";
import { seedFixtures } from "./seed.js";

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT ?? 4000);
const MODEL_API_KEY = process.env.MODEL_API_KEY ?? "";
const LLM_BASE_URL = process.env.LLM_BASE_URL ?? "";
const LLM_MODEL = process.env.LLM_MODEL ?? "";

const HERE = dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = join(HERE, "..", "uploads");
mkdirSync(UPLOADS_DIR, { recursive: true });
app.use("/uploads", express.static(UPLOADS_DIR));

const ACCEPTED_MIMES = new Set(["image/png", "image/jpeg", "video/mp4"]);
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (_req, file, cb) => {
      cb(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, ACCEPTED_MIMES.has(file.mimetype));
  },
});

let db: Db;

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
    dbBackend: dbBackend(),
  });
});

app.get("/api/inventory", async (_req, res) => {
  const { rows } = await db.query("SELECT * FROM inventory ORDER BY shelf_id");
  res.json(rows);
});

app.get("/api/inventory/:shelfId", async (req, res) => {
  const { rows } = await db.query("SELECT * FROM inventory WHERE shelf_id = $1", [
    req.params.shelfId,
  ]);
  if (rows.length === 0) {
    res.status(404).json({ error: "shelf not found" });
    return;
  }
  res.json(rows[0]);
});

// Upload a shelf photo/video and create a scan record. SAM wiring is Slice 3:
// a scan created here stays `pending` (visible_qty null, coverage `unknown`)
// until Slice 3 analysis runs.
app.post("/api/scans", upload.single("media"), async (req, res) => {
  const shelfId = typeof req.body?.shelfId === "string" ? req.body.shelfId : "A-01";
  if (!req.file) {
    res.status(400).json({ error: "media file required (PNG/JPG/MP4)" });
    return;
  }
  const inv = await db.query("SELECT id FROM inventory WHERE shelf_id = $1", [shelfId]);
  if (inv.rows.length === 0) {
    res.status(404).json({ error: "shelf not found" });
    return;
  }
  const scanId = randomUUID();
  const mediaUrl = `/uploads/${req.file.filename}`;
  await db.query(
    "INSERT INTO scans (id, inventory_id, media_url, status) VALUES ($1, $2, $3, 'pending')",
    [scanId, inv.rows[0].id, mediaUrl],
  );
  res.status(201).json({ scanId, status: "pending", mediaUrl });
});

app.get("/api/scans", async (_req, res) => {
  const { rows } = await db.query(
    "SELECT s.*, i.shelf_id, i.sku, i.expected_qty FROM scans s JOIN inventory i ON i.id = s.inventory_id ORDER BY s.created_at DESC",
  );
  res.json(rows);
});

app.get("/api/scans/:id", async (req, res) => {
  const { rows } = await db.query(
    "SELECT s.*, i.shelf_id, i.sku, i.expected_qty FROM scans s JOIN inventory i ON i.id = s.inventory_id WHERE s.id = $1",
    [req.params.id],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: "scan not found" });
    return;
  }
  res.json(rows[0]);
});

// Production single-service shape: serve the client dist for non-API routes.
if (process.env.NODE_ENV === "production") {
  const dist = join(HERE, "..", "..", "client", "dist");
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get("*", (_req, res) => res.sendFile(join(dist, "index.html")));
  }
}

async function main() {
  db = await initDb();
  await seedFixtures(db);
  app.listen(PORT, () => {
    console.log(`realitysync-server listening on :${PORT}`);
  });
}

main().catch((err) => {
  console.error("server failed to start:", err);
  process.exit(1);
});
