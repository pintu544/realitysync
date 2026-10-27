// SAM 3.1 image analysis — the Slice 3 detection path.
// Reuses the exact pattern proven by the Slice 1 probe (probe/sam-probe.mjs):
// Responses API, stream, @meta-sam/parser parseImageStream + recordsOfKind,
// box left/top/right/bottom, dedupe by objectId.
// The Meta key is read from the environment ONLY (MODEL_API_KEY) and is
// never printed, logged, stored, or returned by this module.
import { readFileSync } from "node:fs";
import OpenAI from "openai";
import { parseImageStream, recordsOfKind } from "@meta-sam/parser";

export interface SamBox {
  objectId: number | string;
  left: number;
  top: number;
  right: number;
  bottom: number;
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
    metadata: { mask_encoding: "one_bit" },
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
    boxes.push({ objectId: r.objectId, left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  }
  const maskCount = recordsOfKind(result.records, "mask").length;
  return { outcome, boxes, maskCount, latencyMs, ...dims };
}
