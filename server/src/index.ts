import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import { dbBackend, initDb, type Db } from "./db.js";
import { seedFixtures } from "./seed.js";
import { runAnalysis, inFlightAnalyses } from "./analyze.js";
import { ensureAuditCase, parseAuditCase } from "./investigate.js";

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT ?? 4000);
const MODEL_API_KEY = process.env.MODEL_API_KEY ?? "";
const LLM_BASE_URL = process.env.LLM_BASE_URL ?? "";
const LLM_MODEL = process.env.LLM_MODEL ?? "";

const HERE = dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = join(HERE, "..", "uploads");
mkdirSync(UPLOADS_DIR, { recursive: true });

// Uploaded media is user-supplied content: never serve it inline as an
// executable document. Attachment disposition + nosniff + a sandbox CSP mean
// that even a mislabeled file cannot run script in the app origin.
app.use(
  "/uploads",
  express.static(UPLOADS_DIR, {
    setHeaders(res) {
      res.setHeader("Content-Disposition", "attachment");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    },
  }),
);

// The saved extension is derived ONLY from the validated MIME type — never
// from the client-supplied original filename (C1: a spoofed .html name).
const MIME_TO_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "video/mp4": ".mp4",
};
const ACCEPTED_MIMES = new Set(Object.keys(MIME_TO_EXT));
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (_req, file, cb) => {
      cb(null, `${randomUUID()}${MIME_TO_EXT[file.mimetype] ?? ""}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ACCEPTED_MIMES.has(file.mimetype)) {
      cb(null, true);
    } else {
      // Remember the rejection so the handler can answer 415 (file present
      // but wrong type) instead of 400 (no file at all).
      (req as unknown as { fileRejectedMime?: boolean }).fileRejectedMime = true;
      cb(null, false);
    }
  },
});

async function removeQuiet(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Best-effort cleanup; a missing file is not an error.
  }
}

// Cheap magic-byte check: the file's first bytes must match the MIME type
// multer accepted. A spoofed .html body with Content-Type image/png fails
// here and is deleted before any scan record exists.
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
async function magicMatches(path: string, mime: string): Promise<boolean> {
  let fh;
  try {
    fh = await open(path, "r");
    const buf = Buffer.alloc(12);
    const { bytesRead } = await fh.read(buf, 0, 12, 0);
    if (mime === "image/png") {
      return bytesRead >= 8 && buf.subarray(0, 8).equals(PNG_SIG);
    }
    if (mime === "image/jpeg") {
      return bytesRead >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    }
    if (mime === "video/mp4") {
      return bytesRead >= 8 && buf.subarray(4, 8).toString("ascii") === "ftyp";
    }
    return false;
  } catch {
    return false;
  } finally {
    await fh?.close();
  }
}

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

// Upload a shelf photo/video and create a scan record. Slice 3: image
// scans kick off SAM analysis asynchronously (the upload still returns
// fast); video scans analyze the same way via Slice 4 video tracking.
//
// Error paths delete the uploaded file (W3): a rejected upload must never
// leave an orphan on disk, whatever the failure.
app.post("/api/scans", upload.single("media"), async (req, res) => {
  const shelfId = typeof req.body?.shelfId === "string" ? req.body.shelfId : "A-01";
  if (!req.file) {
    const rejected = (req as unknown as { fileRejectedMime?: boolean }).fileRejectedMime;
    res
      .status(rejected ? 415 : 400)
      .json({ error: rejected ? "unsupported media type (PNG/JPG/MP4 only)" : "media file required (PNG/JPG/MP4)" });
    return;
  }
  const filePath = req.file.path;
  if (!(await magicMatches(filePath, req.file.mimetype))) {
    await removeQuiet(filePath);
    res.status(415).json({ error: "file content does not match its media type" });
    return;
  }
  const inv = await db.query("SELECT id FROM inventory WHERE shelf_id = $1", [shelfId]);
  if (inv.rows.length === 0) {
    await removeQuiet(filePath);
    res.status(404).json({ error: "shelf not found" });
    return;
  }
  const scanId = randomUUID();
  const mediaUrl = `/uploads/${req.file.filename}`;
  try {
    await db.query(
      "INSERT INTO scans (id, inventory_id, media_url, status) VALUES ($1, $2, $3, 'pending')",
      [scanId, inv.rows[0].id, mediaUrl],
    );
  } catch {
    await removeQuiet(filePath);
    res.status(500).json({ error: "failed to create scan" });
    return;
  }
  res.status(201).json({ scanId, status: "pending", mediaUrl });
  // Analysis runs in the background; its outcome lands on the scan row.
  void runAnalysis(db, scanId);
});

// Slice 4 QA C1: a non-UUID scan id must never reach a uuid column —
// real Postgres rejects it exactly like pg-mem does, and Express 4 does
// not catch rejected async handlers, so the process dies. Validate the
// shape first (400), and keep a try/catch around the queries anyway so
// any other DB failure answers JSON instead of killing the server.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(id: string): boolean {
  return UUID_RE.test(id);
}

function withDetections(row: Record<string, unknown>): Record<string, unknown> {
  let boxes: unknown = row.boxes ?? null;
  if (typeof boxes === "string") {
    try {
      boxes = JSON.parse(boxes);
    } catch {
      boxes = null;
    }
  }
  // Same treatment for video_stats: pg-mem returns the JSONB column as a
  // string, real Postgres as an object. The client reads .uniqueObjects /
  // .framesWithBoxes off it, so a raw string would render blank counts.
  let videoStats: unknown = row.video_stats ?? null;
  if (typeof videoStats === "string") {
    try {
      videoStats = JSON.parse(videoStats);
    } catch {
      videoStats = null;
    }
  }
  const hasDetections = row.boxes !== null && row.boxes !== undefined;
  return {
    ...row,
    detections: hasDetections
      ? {
          boxes,
          mask_count: row.mask_count ?? null,
          latency_ms: row.latency_ms ?? null,
          error: row.analysis_error ?? null,
          analyzed_at: row.analyzed_at ?? null,
          raw_box_count: row.raw_box_count ?? null,
          video_stats: videoStats,
        }
      : null,
    needs_review: row.status === "analyzed" && row.coverage_status !== "full",
    // Slice 5: the audit case travels with the scan (null until analysis
    // completes — failed scans never get a case).
    audit_case:
      row.case_id === null || row.case_id === undefined
        ? null
        : parseAuditCase({
            id: row.case_id,
            scan_id: row.id,
            recommendation: row.case_recommendation,
            state: row.case_state,
            approved_qty: null,
            created_at: "",
          }),
  };
}

app.get("/api/scans", async (_req, res) => {
  const { rows } = await db.query(
    `SELECT s.*, i.shelf_id, i.sku, i.expected_qty,
       d.boxes, d.mask_count, d.latency_ms, d.error AS analysis_error, d.analyzed_at, d.raw_box_count, d.video_stats,
       a.id AS case_id, a.recommendation AS case_recommendation, a.state AS case_state
     FROM scans s JOIN inventory i ON i.id = s.inventory_id
     LEFT JOIN scan_detections d ON d.scan_id = s.id
     LEFT JOIN audit_cases a ON a.scan_id = s.id
     ORDER BY s.created_at DESC`,
  );
  res.json(rows.map(withDetections));
});

app.get("/api/scans/:id", async (req, res) => {
  if (!isUuid(req.params.id)) {
    res.status(400).json({ error: "invalid scan id" });
    return;
  }
  let rows;
  try {
    ({ rows } = await db.query(
      `SELECT s.*, i.shelf_id, i.sku, i.expected_qty,
       d.boxes, d.mask_count, d.latency_ms, d.error AS analysis_error, d.analyzed_at, d.raw_box_count, d.video_stats,
       a.id AS case_id, a.recommendation AS case_recommendation, a.state AS case_state
     FROM scans s JOIN inventory i ON i.id = s.inventory_id
     LEFT JOIN scan_detections d ON d.scan_id = s.id
     LEFT JOIN audit_cases a ON a.scan_id = s.id
     WHERE s.id = $1`,
      [req.params.id],
    ));
  } catch {
    res.status(500).json({ error: "internal error" });
    return;
  }
  if (rows.length === 0) {
    res.status(404).json({ error: "scan not found" });
    return;
  }
  res.json(withDetections(rows[0]));
});

// Re-run SAM analysis for a pending or failed scan. Analyzed scans are
// refused; video scans analyze via Slice 4 video tracking.
app.post("/api/scans/:id/analyze", async (req, res) => {
  if (!isUuid(req.params.id)) {
    res.status(400).json({ error: "invalid scan id" });
    return;
  }
  let rows;
  try {
    ({ rows } = await db.query("SELECT * FROM scans WHERE id = $1", [req.params.id]));
  } catch {
    res.status(500).json({ error: "internal error" });
    return;
  }
  if (rows.length === 0) {
    res.status(404).json({ error: "scan not found" });
    return;
  }
  const scan = rows[0];
  if (scan.status === "analyzed") {
    res.status(409).json({ error: "scan already analyzed" });
    return;
  }
  if (inFlightAnalyses.has(req.params.id)) {
    res.status(409).json({ error: "analysis already running" });
    return;
  }
  void runAnalysis(db, req.params.id);
  res.json({ scanId: req.params.id, status: "pending" });
});

// Slice 5: re-run the Muse Spark investigation for an analyzed scan whose
// case has no (or a failed) investigation. Idempotent: a case with an
// investigation already present is returned unchanged, no second model call.
app.post("/api/scans/:id/investigate", async (req, res) => {
  if (!isUuid(req.params.id)) {
    res.status(400).json({ error: "invalid scan id" });
    return;
  }
  let rows;
  try {
    ({ rows } = await db.query("SELECT * FROM scans WHERE id = $1", [req.params.id]));
  } catch {
    res.status(500).json({ error: "internal error" });
    return;
  }
  if (rows.length === 0) {
    res.status(404).json({ error: "scan not found" });
    return;
  }
  if (rows[0].status !== "analyzed") {
    res.status(409).json({ error: "scan not analyzed yet" });
    return;
  }
  const auditCase = await ensureAuditCase(db, req.params.id);
  if (!auditCase) {
    res.status(500).json({ error: "could not load audit case" });
    return;
  }
  res.json({ audit_case: auditCase });
});

// I1: unknown API routes answer JSON 404, never an HTML fallback. This
// sits after all API routes and before the error handler; the production
// SPA catch-all below only serves non-API paths.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "not found" });
});

// Error handler (W2): API errors are always JSON, never an HTML stack trace.
// Multer limit breaches are 413; other multer errors are 400. Any file that
// survived a failed upload is removed here too.
app.use(
  (
    err: unknown,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (req.file) {
      void removeQuiet(req.file.path);
    }
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: "file exceeds the 25MB limit" });
        return;
      }
      res.status(400).json({ error: `upload rejected (${err.code})` });
      return;
    }
    if (err instanceof SyntaxError) {
      res.status(400).json({ error: "malformed JSON body" });
      return;
    }
    if (!res.headersSent) {
      res.status(500).json({ error: "internal error" });
    } else {
      next(err);
    }
  },
);

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
