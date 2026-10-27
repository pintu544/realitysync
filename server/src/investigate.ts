// Audit case generation (Slice 5). After a scan reaches `analyzed`, this
// module creates (or refreshes) its audit case: deterministic numbers
// computed by code, a Muse Spark investigation from the evidence envelope
// only, and safe_to_auto_update ALWAYS false (no auto-update path exists
// in Slice 5; Slice 6 defines the criteria). The case state stays
// `needs_review` in Slice 5 — approval lands in Slice 6.
// Fail-closed: a Spark failure still yields a case, with investigation
// null and an honest investigation_error note — never a fabricated
// explanation. The model output is stored verbatim; the case-level
// needs_review is computed by code (coverage rule wins over model text).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { investigateDiscrepancy, type InvestigationEvidence } from "./spark.js";
import { imageDimensions, mp4Dimensions } from "./sam.js";
import type { Db } from "./db.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = join(HERE, "..", "uploads");

function parseJson(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value ?? null;
}

export interface AuditCase {
  id: string;
  scan_id: string;
  recommendation: Record<string, unknown> | null;
  state: string;
  approved_qty: number | null;
  created_at: string;
}

export function parseAuditCase(row: Record<string, unknown> | null | undefined): AuditCase | null {
  if (!row || row.id === null || row.id === undefined) return null;
  return {
    id: String(row.id),
    scan_id: String(row.scan_id),
    recommendation: (parseJson(row.recommendation) as Record<string, unknown> | null) ?? null,
    state: String(row.state ?? "needs_review"),
    approved_qty: (row.approved_qty as number | null) ?? null,
    created_at: String(row.created_at ?? ""),
  };
}

async function loadScan(db: Db, scanId: string): Promise<Record<string, unknown> | null> {
  const { rows } = await db.query(
    `SELECT s.*, i.shelf_id, i.sku, i.expected_qty,
       d.boxes, d.mask_count, d.latency_ms, d.raw_box_count, d.video_stats
     FROM scans s JOIN inventory i ON i.id = s.inventory_id
     LEFT JOIN scan_detections d ON d.scan_id = s.id
     WHERE s.id = $1`,
    [scanId],
  );
  return rows.length === 0 ? null : rows[0];
}

interface BoxSummary {
  index: number;
  border_touch: boolean;
  confidence: number | null;
}

// Border-touch flags need image/frame dimensions, which are NOT stored on
// the detection row — they are re-read from the media file (the same
// source analysis used). If the file is gone, dimensions_known is false
// and every flag reads false: the envelope says so plainly instead of
// claiming flags it cannot support.
function buildEvidence(scan: Record<string, unknown>): InvestigationEvidence {
  const boxesRaw = (parseJson(scan.boxes) as Array<Record<string, unknown>> | null) ?? [];
  const mediaUrl = String(scan.media_url);
  const isVideo = /\.mp4$/i.test(mediaUrl);
  const mime = isVideo ? "video/mp4" : /\.jpg$/i.test(mediaUrl) ? "image/jpeg" : "image/png";
  let dims: { width: number; height: number } | null = null;
  try {
    const buf = readFileSync(join(UPLOADS_DIR, basename(mediaUrl)));
    dims = isVideo ? mp4Dimensions(buf) : imageDimensions(buf, mime);
  } catch {
    dims = null;
  }
  const boxes: BoxSummary[] = boxesRaw.map((b, i) => {
    const border_touch =
      dims !== null &&
      (Number(b.left) <= 0.02 * dims.width ||
        Number(b.top) <= 0.02 * dims.height ||
        Number(b.right) >= dims.width - 0.02 * dims.width ||
        Number(b.bottom) >= dims.height - 0.02 * dims.height);
    return {
      index: i,
      border_touch,
      confidence: typeof b.confidence === "number" ? b.confidence : null,
    };
  });
  const expected = Number(scan.expected_qty);
  const visible = Number(scan.visible_qty);
  return {
    shelf_id: String(scan.shelf_id),
    sku: String(scan.sku),
    expected_qty: expected,
    visible_qty: visible,
    difference: visible - expected,
    coverage_status: String(scan.coverage_status),
    media_type: isVideo ? "video" : "image",
    box_count: boxes.length,
    raw_box_count: (scan.raw_box_count as number | null) ?? null,
    mask_count: (scan.mask_count as number | null) ?? null,
    latency_ms: (scan.latency_ms as number | null) ?? null,
    video_stats: (parseJson(scan.video_stats) as InvestigationEvidence["video_stats"]) ?? null,
    boxes,
    dimensions_known: dims !== null,
  };
}

// Creates or refreshes the audit case for an analyzed scan. Returns null
// for pending/failed scans (no evidence to investigate) and for unknown
// scans. Never throws to the caller: a Spark failure is recorded on the
// case itself, and a DB failure is logged, so a case problem can never
// flip a scan back out of `analyzed`.
export async function ensureAuditCase(db: Db, scanId: string): Promise<AuditCase | null> {
  let scan: Record<string, unknown> | null;
  try {
    scan = await loadScan(db, scanId);
  } catch {
    console.error("audit case load failed");
    return null;
  }
  if (!scan || scan.status !== "analyzed") return null;
  const evidence = buildEvidence(scan);
  const needsInvestigation =
    evidence.visible_qty !== evidence.expected_qty || evidence.coverage_status !== "full";

  try {
    const existing = await db.query("SELECT * FROM audit_cases WHERE scan_id = $1", [scanId]);
    const existingCase = existing.rows.length > 0 ? parseAuditCase(existing.rows[0]) : null;
    const existingRec = (existingCase?.recommendation ?? {}) as Record<string, unknown>;
    // Idempotent: an existing investigation is never re-bought.
    if (existingCase && existingRec.investigation) return existingCase;

    let investigation: unknown = null;
    let investigationError: string | null = null;
    let action = "case_created";
    if (!needsInvestigation) {
      investigation = null;
    } else {
      try {
        const result = await investigateDiscrepancy(evidence);
        investigation = result.investigation;
        action = existingCase ? "case_refreshed" : "investigation_created";
      } catch (err) {
        investigation = null;
        investigationError =
          err instanceof Error ? err.message.slice(0, 200) : "investigation failed";
        action = "investigation_failed";
      }
    }
    // Coverage rule wins: a partial/unknown scan stays needs_review even
    // if the model says otherwise. The model output itself is stored
    // verbatim; this top-level flag is the code-computed verdict. A
    // clean match (no investigation needed) is NOT review-needing at
    // this level — the case `state` still reads needs_review in Slice 5
    // because no approval transition exists yet (Slice 6); the two fields
    // answer different questions (verdict vs workflow state).
    const modelNeedsReview = !needsInvestigation
      ? false
      : investigation && typeof investigation === "object"
        ? Boolean((investigation as Record<string, unknown>).needs_review)
        : true;
    const recommendation = {
      deterministic: {
        expected_qty: evidence.expected_qty,
        visible_qty: evidence.visible_qty,
        difference: evidence.difference,
      },
      evidence,
      investigation,
      investigation_error: investigationError,
      note: !needsInvestigation ? "counts match; no investigation needed" : null,
      // Pinned Slice 5 rule: always false. No auto-update path exists.
      safe_to_auto_update: false,
      needs_review: evidence.coverage_status !== "full" || modelNeedsReview,
    };
    if (existingCase) {
      await db.query(
        "UPDATE audit_cases SET recommendation = $1 WHERE id = $2",
        [JSON.stringify(recommendation), existingCase.id],
      );
      await db.query(
        "INSERT INTO audit_events (id, case_id, action, details) VALUES ($1, $2, $3, $4)",
        [randomUUID(), existingCase.id, action, JSON.stringify({ scan_id: scanId })],
      );
      const refreshed = await db.query("SELECT * FROM audit_cases WHERE id = $1", [existingCase.id]);
      return parseAuditCase(refreshed.rows[0]);
    }
    // Race guard: the Spark call above takes seconds, so a concurrent
    // /investigate request may have inserted a case while we were
    // waiting. Re-check before inserting — one case per scan, enforced
    // here in code and by the unique index in db.ts. If a case with an
    // investigation appeared, it wins; if one without appeared, our
    // fresh recommendation updates it below via the shared path.
    const recheck = await db.query("SELECT * FROM audit_cases WHERE scan_id = $1", [scanId]);
    if (recheck.rows.length > 0) {
      const raced = parseAuditCase(recheck.rows[0]);
      const racedRec = (raced?.recommendation ?? {}) as Record<string, unknown>;
      if (raced && racedRec.investigation) return raced;
      if (raced) {
        await db.query(
          "UPDATE audit_cases SET recommendation = $1 WHERE id = $2",
          [JSON.stringify(recommendation), raced.id],
        );
        await db.query(
          "INSERT INTO audit_events (id, case_id, action, details) VALUES ($1, $2, $3, $4)",
          [randomUUID(), raced.id, action, JSON.stringify({ scan_id: scanId })],
        );
        const refreshed = await db.query("SELECT * FROM audit_cases WHERE id = $1", [raced.id]);
        return parseAuditCase(refreshed.rows[0]);
      }
    }
    const caseId = randomUUID();
    try {
      await db.query(
        "INSERT INTO audit_cases (id, scan_id, recommendation, state, approved_qty) VALUES ($1, $2, $3, 'needs_review', NULL)",
        [caseId, scanId, JSON.stringify(recommendation)],
      );
    } catch {
      // Lost the insert race despite the re-check (two writers between
      // re-check and insert): the unique index kept one case. Return the
      // winner instead of failing the request.
      const winner = await db.query("SELECT * FROM audit_cases WHERE scan_id = $1", [scanId]);
      if (winner.rows.length > 0) return parseAuditCase(winner.rows[0]);
      throw new Error("audit case insert failed");
    }
    await db.query(
      "INSERT INTO audit_events (id, case_id, action, details) VALUES ($1, $2, $3, $4)",
      [randomUUID(), caseId, action, JSON.stringify({ scan_id: scanId })],
    );
    const created = await db.query("SELECT * FROM audit_cases WHERE id = $1", [caseId]);
    return parseAuditCase(created.rows[0]);
  } catch {
    console.error("audit case write failed");
    return null;
  }
}

export async function getAuditCase(db: Db, scanId: string): Promise<AuditCase | null> {
  const { rows } = await db.query("SELECT * FROM audit_cases WHERE scan_id = $1", [scanId]);
  return rows.length === 0 ? null : parseAuditCase(rows[0]);
}
