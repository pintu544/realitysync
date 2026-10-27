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
import { analyzeImage, analyzeVideo, type SamBox, type SamVideoBox } from "./sam.js";
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
// (within 3% of image width) that are vertically adjacent in EITHER order
// are one physical box SAM segmented in two. Adjacency is symmetric: the
// vertical overlap min(bottom) - max(top) lies in [-10, 2]px (a gap of up
// to 10px, or an overlap of up to 2px of edge jitter). The one-directional
// gap check it replaces broke when the sort order put the lower half
// first (Slice 3 QA W1). Applied transitively. Returns the merged set;
// the raw count is preserved separately for auditability.
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
        const overlap = Math.min(merged.bottom, other.bottom) - Math.max(merged.top, other.top);
        if (xMatch && overlap >= -10 && overlap <= 2) {
          merged = {
            objectId: merged.objectId,
            left: Math.min(merged.left, other.left),
            top: Math.min(merged.top, other.top),
            right: Math.max(merged.right, other.right),
            bottom: Math.max(merged.bottom, other.bottom),
            ...(merged.confidence !== undefined ? { confidence: merged.confidence } : {}),
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

// Minimum box-size filter (Slice 4 W7, threshold in DESIGN.md): drop boxes
// below 0.1% of the image area before merging/counting. Runs before the
// merge so a noise sliver never joins a real box. Generic so video
// representative boxes keep their frame-span fields.
export function filterSmallBoxes<T extends SamBox>(boxes: T[], width: number, height: number): T[] {
  const minArea = 0.001 * width * height;
  return boxes.filter((b) => (b.right - b.left) * (b.bottom - b.top) >= minArea);
}

// In-flight analysis guard (Slice 4 W4): scan ids with a run active right
// now. Checked by the analyze endpoint (409 while running) and by
// runAnalysis itself (a duplicate trigger returns without a second Meta
// call). Entries are removed in a finally block on every path.
export const inFlightAnalyses = new Set<string>();

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".mp4": "video/mp4",
};

// Video coverage (Slice 4, documented in DESIGN.md before coding):
//   unknown  — zero tracked objects (a static-camera clip can return
//              nothing at all; that is never read as "shelf is empty").
//   partial  — boxes present in <80% of frames up to the max observed
//              frame (tracking dropped out for part of the clip), or a
//              representative box touches a frame border (within 2%), or
//              two representative boxes overlap with IoU > 0.5.
//   full     — otherwise.
// Representative boxes are each object's first-seen frame box; per-frame
// overlap detail is not retained (known limitation, Slice 6 watch item).
// Only `full` yields a confident visible count, same as images.
export function classifyVideoCoverage(
  boxes: SamVideoBox[],
  width: number,
  height: number,
  framesWithBoxes: number,
  maxFrame: number,
): Coverage {
  if (boxes.length === 0) return "unknown";
  const total = maxFrame + 1;
  if (total > 0 && framesWithBoxes / total < 0.8) return "partial";
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

// Runs SAM analysis for one scan and persists the outcome. Never throws
// to the caller: every failure path lands on the scan row as `failed`.
// A duplicate trigger for a scan with a run already active returns
// immediately (W4 in-flight guard) instead of double-charging Meta.
export async function runAnalysis(db: Db, scanId: string): Promise<void> {
  let scan: Record<string, unknown>;
  try {
    const rows = await db.query("SELECT * FROM scans WHERE id = $1", [scanId]);
    if (rows.rows.length === 0) return;
    scan = rows.rows[0];
  } catch {
    // I3: the initial lookup must never become an unhandled void rejection.
    console.error("analysis lookup failed");
    return;
  }
  if (inFlightAnalyses.has(scanId)) return;
  inFlightAnalyses.add(scanId);
  try {
    await runAnalysisInner(db, scanId, scan);
  } finally {
    inFlightAnalyses.delete(scanId);
  }
}

async function runAnalysisInner(
  db: Db,
  scanId: string,
  scan: Record<string, unknown>,
): Promise<void> {
  const mediaUrl: string = scan.media_url as string;
  const ext = extname(mediaUrl).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) return;
  const filePath = join(UPLOADS_DIR, basename(mediaUrl));
  try {
    if (mime === "video/mp4") {
      await runVideoAnalysis(db, scanId, filePath);
      return;
    }
    const result = await analyzeImage(filePath, mime);
    const filtered = filterSmallBoxes(result.boxes, result.width, result.height);
    const boxes = mergeVerticalSplits(filtered, result.width);
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
    // I2: filesystem errors map to a generic message — never persist a
    // raw path or OS error string on the scan row.
    const safe = /ENOENT|EACCES|no such file|permission denied/i.test(message)
      ? "media file unavailable"
      : message.length > 200
        ? message.slice(0, 200)
        : message;
    try {
      await db.query("DELETE FROM scan_detections WHERE scan_id = $1", [scanId]);
      await db.query(
        "INSERT INTO scan_detections (scan_id, boxes, mask_count, latency_ms, error, analyzed_at, raw_box_count) VALUES ($1, '[]', 0, NULL, $2, NOW(), NULL)",
        [scanId, safe],
      );
      await db.query(
        "UPDATE scans SET visible_qty = NULL, coverage_status = 'unknown', status = 'failed' WHERE id = $1",
        [scanId],
      );
    } catch {
      console.error("analysis failure could not be recorded");
    }
  }
}

// Video analysis persistence (Slice 4). The counted set is the unique
// tracked objects (objectId dedupe inside analyzeVideo); the min-size
// filter applies to representative boxes, same 0.1% threshold as images.
// Per-frame tape-split merging is NOT applied to video: the tracker's
// identity is the count signal, and merging first-seen boxes from
// different objects could wrongly collapse distinct shelf neighbors.
// A video split inflating the unique count is a Slice 6 eval watch item.
async function runVideoAnalysis(db: Db, scanId: string, filePath: string): Promise<void> {
  const result = await analyzeVideo(filePath);
  const filtered = filterSmallBoxes(result.boxes, result.frameWidth, result.frameHeight);
  const coverage = classifyVideoCoverage(
    filtered,
    result.frameWidth,
    result.frameHeight,
    result.framesWithBoxes,
    result.maxFrame,
  );
  const videoStats = {
    framesWithBoxes: result.framesWithBoxes,
    maxFrame: result.maxFrame,
    uniqueObjects: filtered.length,
  };
  await db.query("DELETE FROM scan_detections WHERE scan_id = $1", [scanId]);
  await db.query(
    "INSERT INTO scan_detections (scan_id, boxes, mask_count, latency_ms, error, analyzed_at, raw_box_count, video_stats) VALUES ($1, $2, $3, $4, NULL, NOW(), $5, $6)",
    [scanId, JSON.stringify(filtered), result.maskCount, result.latencyMs, result.boxRecords, JSON.stringify(videoStats)],
  );
  await db.query(
    "UPDATE scans SET visible_qty = $1, coverage_status = $2, status = 'analyzed' WHERE id = $3",
    [filtered.length, coverage, scanId],
  );
}
