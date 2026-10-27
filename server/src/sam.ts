// SAM 3.1 image analysis — the Slice 3 detection path.
// Reuses the exact pattern proven by the Slice 1 probe (probe/sam-probe.mjs):
// Responses API, stream, @meta-sam/parser parseImageStream + recordsOfKind,
// box left/top/right/bottom, dedupe by objectId.
// The Meta key is read from the environment ONLY (MODEL_API_KEY) and is
// never printed, logged, stored, or returned by this module.
import { readFileSync } from "node:fs";
import OpenAI, { toFile } from "openai";
import { parseImageStream, parseVideoStream, recordsOfKind, frameIndexOf } from "@meta-sam/parser";

export interface SamBox {
  objectId: number | string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  // SAM's per-record confidence (token `c`), when the API populated it.
  // Absent means the API omitted it, NOT zero. Preserved (Slice 4 W6) so
  // Slice 6 evaluation can weight or filter by confidence.
  confidence?: number;
}

export interface SamImageResult {
  outcome: string | null;
  boxes: SamBox[];
  maskCount: number;
  latencyMs: number;
  width: number;
  height: number;
}

// Minimal dimension readers (PNG IHDR, JPEG SOF) — no extra dependency.
// Needed so coverage classification can test border-touching in pixels.
function pngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return null;
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpegDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    // SOF0/SOF1/SOF2 carry dimensions (excluding DHT/DAC/JPGn/RSTn).
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xda) return null; // start of scan: no SOF found
    i += 2 + len;
  }
  return null;
}

export function imageDimensions(buf: Buffer, mime: string): { width: number; height: number } {
  const dims = mime === "image/png" ? pngDimensions(buf) : jpegDimensions(buf);
  if (!dims) throw new Error("could not read image dimensions");
  return dims;
}

export interface SamVideoBox extends SamBox {
  firstFrame: number;
  lastFrame: number;
  sightings: number;
}

export interface SamVideoResult {
  outcome: string | null;
  // One representative box per unique tracked object (first frame seen),
  // with its frame span — the counted set. Per-frame boxes are NOT the
  // count: one tracked object counts once, however many frames show it.
  boxes: SamVideoBox[];
  maskCount: number;
  latencyMs: number;
  frameWidth: number;
  frameHeight: number;
  framesWithBoxes: number;
  maxFrame: number;
  // Total per-frame box records before objectId dedupe (auditability:
  // the video analogue of the image path's raw_box_count).
  boxRecords: number;
}

// Minimal MP4 dimension reader: walks moov > trak > tkhd and reads the
// 16.16 fixed-point width/height. Box records from the parser do not carry
// frame size, so the file itself is the source of truth for the video
// coverage math (border-touch, min-size filter).
export function mp4Dimensions(buf: Buffer): { width: number; height: number } | null {
  function walk(start: number, end: number, depth: number): { width: number; height: number } | null {
    let i = start;
    while (i + 8 <= end) {
      const size = buf.readUInt32BE(i);
      const type = buf.subarray(i + 4, i + 8).toString("ascii");
      let header = 8;
      let boxEnd: number;
      if (size === 1) {
        if (i + 16 > end) return null;
        boxEnd = i + Number(buf.readBigUInt64BE(i + 8));
        header = 16;
      } else if (size === 0) {
        boxEnd = end;
      } else {
        boxEnd = i + size;
      }
      if (boxEnd > end) return null;
      if (type === "tkhd" && depth >= 2) {
        const version = buf[i + header];
        const off = i + header + (version === 1 ? 88 : 76);
        if (off + 8 <= boxEnd) {
          const width = buf.readUInt32BE(off) / 65536;
          const height = buf.readUInt32BE(off + 4) / 65536;
          if (width > 0 && height > 0) return { width, height };
        }
      }
      if ((type === "moov" || type === "trak") && depth < 4) {
        const found = walk(i + header, boxEnd, depth + 1);
        if (found) return found;
      }
      i = boxEnd;
    }
    return null;
  }
  return walk(0, buf.length, 0);
}

// Slice 4 video path. Uploads the MP4 to Meta's Files API (purpose
// user_data, verified live 2026-10-27), then calls sam-3.1 with an
// input_video part carrying the returned file_id, and parses the stream
// with parseVideoStream. Object ids are stable across frames of one
// response (parser contract), so dedupe by objectId is the count.
export async function analyzeVideo(filePath: string): Promise<SamVideoResult> {
  const key = process.env.MODEL_API_KEY ?? "";
  if (!key) {
    throw new Error("Meta API not configured (MODEL_API_KEY missing)");
  }
  const client = new OpenAI({ apiKey: key, baseURL: "https://api.meta.ai/v1" });
  const buf = readFileSync(filePath);
  const dims = mp4Dimensions(buf);
  if (!dims) throw new Error("could not read video dimensions");
  const uploaded = await client.files.create({
    file: await toFile(buf, "scan.mp4"),
    purpose: "user_data",
  });
  const started = Date.now();
  const stream = await client.responses.create({
    model: "sam-3.1",
    stream: true,
    metadata: { mask_encoding: "one_bit", include_confidence: "true" },
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "cardboard box" },
          // input_video is a Meta extension the OpenAI SDK types do not
          // name; it is sent as a plain wire object (verified live).
          { type: "input_video", file_id: uploaded.id } as never,
        ],
      },
    ],
  });
  const parsed = parseVideoStream(stream);
  const result = await parsed.finalResult;
  const latencyMs = Date.now() - started;
  const outcome = result.outcome?.status ?? null;
  if (outcome !== "completed") {
    throw new Error(`SAM video segmentation incomplete (outcome: ${outcome ?? "unknown"})`);
  }
  const byObject = new Map<string, SamVideoBox>();
  const framesWith = new Set<number>();
  let maxFrame = -1;
  for (const r of recordsOfKind(result.records, "box")) {
    const frame = frameIndexOf(r) ?? 0;
    framesWith.add(frame);
    if (frame > maxFrame) maxFrame = frame;
    const prev = byObject.get(String(r.objectId));
    if (prev) {
      prev.lastFrame = Math.max(prev.lastFrame, frame);
      prev.sightings += 1;
    } else {
      byObject.set(String(r.objectId), {
        objectId: r.objectId,
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        ...(r.confidence !== undefined ? { confidence: r.confidence } : {}),
        firstFrame: frame,
        lastFrame: frame,
        sightings: 1,
      });
    }
  }
  const maskCount = recordsOfKind(result.records, "mask").length;
  return {
    outcome,
    boxes: [...byObject.values()],
    maskCount,
    latencyMs,
    frameWidth: dims.width,
    frameHeight: dims.height,
    framesWithBoxes: framesWith.size,
    maxFrame,
    boxRecords: recordsOfKind(result.records, "box").length,
  };
}

export async function analyzeImage(filePath: string, mime: string): Promise<SamImageResult> {
  const key = process.env.MODEL_API_KEY ?? "";
  if (!key) {
    throw new Error("Meta API not configured (MODEL_API_KEY missing)");
  }
  const buf = readFileSync(filePath);
  const dims = imageDimensions(buf, mime);
  const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
  const client = new OpenAI({ apiKey: key, baseURL: "https://api.meta.ai/v1" });
  const started = Date.now();
  const stream = await client.responses.create({
    model: "sam-3.1",
    stream: true,
    // include_confidence asks SAM to populate the per-record `c` token so
    // confidence survives into scan_detections (Slice 4 W6); records without
    // it are still accepted, and absence never means zero.
    metadata: { mask_encoding: "one_bit", include_confidence: "true" },
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "cardboard box" },
          { type: "input_image", image_url: dataUrl, detail: "auto" },
        ],
      },
    ],
  });
  const parsed = parseImageStream(stream);
  const result = await parsed.finalResult;
  const latencyMs = Date.now() - started;
  const outcome = result.outcome?.status ?? null;
  if (outcome !== "completed") {
    throw new Error(`SAM segmentation incomplete (outcome: ${outcome ?? "unknown"})`);
  }
  const seen = new Set<number | string>();
  const boxes: SamBox[] = [];
  for (const r of recordsOfKind(result.records, "box")) {
    if (seen.has(r.objectId)) continue;
    seen.add(r.objectId);
    boxes.push({
      objectId: r.objectId,
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      ...(r.confidence !== undefined ? { confidence: r.confidence } : {}),
    });
  }
  const maskCount = recordsOfKind(result.records, "mask").length;
  return { outcome, boxes, maskCount, latencyMs, ...dims };
}
