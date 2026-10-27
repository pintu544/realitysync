// Async scan analysis + coverage classification (Slice 3).
// The upload endpoint returns fast; analysis runs in the background and
// updates the scan row when it finishes. A failure never fabricates a
// count: the scan becomes `failed` with an honest error string.
//
// Coverage heuristic (documented in DESIGN.md before coding):
//   unknown  — SAM failed, or zero detections (empty vs missed is
//              indistinguishable, so never read as "shelf is empty").
//   partial  — completed with >=1 detection AND a box touches an image
//              border (within 2%) or two boxes overlap with IoU > 0.5.
//   full     — completed with >=1 detection and neither signal.
// Only `full` yields a confident visible count; anything else surfaces
// as needs_review and must never feed an inventory correction.
import { join, extname, basename } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeImage, type SamBox } from "./sam.js";
import type { Db } from "./db.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = join(HERE, "..", "uploads");

export type Coverage = "full" | "partial" | "unknown";

function iou(a: SamBox, b: SamBox): number {
  const x1 = Math.max(a.left, b.left);
  const y1 = Math.max(a.top, b.top);
  const x2 = Math.min(a.right, b.right);
  const y2 = Math.min(a.bottom, b.bottom);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter === 0) return 0;
  const areaA = Math.max(0, a.right - a.left) * Math.max(0, a.bottom - a.top);
  const areaB = Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top);
  const union = areaA + areaB - inter;
  return union === 0 ? 0 : inter / union;
}

export function classifyCoverage(
  boxes: SamBox[],
  width: number,
  height: number,
): Coverage {
  if (boxes.length === 0) return "unknown";
  const marginX = 0.02 * width;
  const marginY = 0.02 * height;
  for (const b of boxes) {
    if (b.left <= marginX || b.top <= marginY || b.right >= width - marginX || b.bottom >= height - marginY) {
      return "partial";
    }
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (iou(boxes[i], boxes[j]) > 0.5) return "partial";
    }
  }
  return "full";
}

// Merge vertical tape-line splits: two boxes with matching x-extent
// (within 3% of image width) stacked with a gap in [-2, 10]px are one
// physical box SAM segmented in two. Applied transitively. Returns the
// merged set; the raw count is preserved separately for auditability.
export function mergeVerticalSplits(boxes: SamBox[], width: number): SamBox[] {
  const tol = 0.03 * width;
  const sorted = [...boxes].sort((a, b) => a.left - b.left || a.top - b.top);
  let changed = true;
  let current = sorted;
  while (changed) {
    changed = false;
    const out: SamBox[] = [];
    const used = new Set<number>();
    for (let i = 0; i < current.length; i++) {
      if (used.has(i)) continue;
      let merged = current[i];
      for (let j = i + 1; j < current.length; j++) {
        if (used.has(j)) continue;
        const other = current[j];
        const xMatch =
          Math.abs(other.left - merged.left) <= tol && Math.abs(other.right - merged.right) <= tol;
        const gap = other.top - merged.bottom;
        if (xMatch && gap >= -2 && gap <= 10) {
          merged = {
            objectId: merged.objectId,
            left: Math.min(merged.left, other.left),
            top: Math.min(merged.top, other.top),
            right: Math.max(merged.right, other.right),
            bottom: Math.max(merged.bottom, other.bottom),
          };
          used.add(j);
          changed = true;
        }
      }
      out.push(merged);
      used.add(i);
    }
    current = out;
  }
  return current;
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

// Runs SAM analysis for one scan and persists the outcome. Never throws
// to the caller: every failure path lands on the scan row as `failed`.
export async function runAnalysis(db: Db, scanId: string): Promise<void> {
  const rows = await db.query("SELECT * FROM scans WHERE id = $1", [scanId]);
  if (rows.rows.length === 0) return;
  const scan = rows.rows[0];
  const mediaUrl: string = scan.media_url;
  const ext = extname(mediaUrl).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    // Video scans are Slice 4. Leave them pending/unknown; never fake an
    // image result for a video.
    return;
  }
  const filePath = join(UPLOADS_DIR, basename(mediaUrl));
  try {
    const result = await analyzeImage(filePath, mime);
    const boxes = mergeVerticalSplits(result.boxes, result.width);
    const coverage = classifyCoverage(boxes, result.width, result.height);
    await db.query("DELETE FROM scan_detections WHERE scan_id = $1", [scanId]);
    await db.query(
      "INSERT INTO scan_detections (scan_id, boxes, mask_count, latency_ms, error, analyzed_at, raw_box_count) VALUES ($1, $2, $3, $4, NULL, NOW(), $5)",
      [scanId, JSON.stringify(boxes), result.maskCount, result.latencyMs, result.boxes.length],
    );
    await db.query(
      "UPDATE scans SET visible_qty = $1, coverage_status = $2, status = 'analyzed' WHERE id = $3",
      [boxes.length, coverage, scanId],
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "analysis failed";
    // Never persist key material or stack traces in the error string.
    const safe = message.length > 200 ? message.slice(0, 200) : message;
    await db.query("DELETE FROM scan_detections WHERE scan_id = $1", [scanId]);
    await db.query(
      "INSERT INTO scan_detections (scan_id, boxes, mask_count, latency_ms, error, analyzed_at, raw_box_count) VALUES ($1, '[]', 0, NULL, $2, NOW(), NULL)",
      [scanId, safe],
    );
    await db.query(
      "UPDATE scans SET visible_qty = NULL, coverage_status = 'unknown', status = 'failed' WHERE id = $1",
      [scanId],
    );
  }
}
