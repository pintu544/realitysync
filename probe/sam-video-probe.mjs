// Video gate probe (Slice 4): MP4 upload via Meta Files API (purpose
// user_data) + sam-3.1 video segmentation via parseVideoStream.
// Reads the Meta key from the environment ONLY (MODEL_API_KEY) and never
// prints, logs, stores, or commits it. Mask rasters are never printed.
//
// Usage (key read transiently, never typed into a file or command):
//   MODEL_API_KEY=<from goal .env> NODE_USE_ENV_PROXY=1 \
//     node probe/sam-video-probe.mjs [mp4-path]
//
// Exit 0 = completed video result parsed; anything else = video path NOT
// proven (the S4.2 decision then leans photo-only).
import { readFileSync } from "node:fs";
import OpenAI, { toFile } from "openai";
import { parseVideoStream, recordsOfKind, frameIndexOf } from "@meta-sam/parser";

const MP4 = process.argv[2] ?? "/tmp/shelf-pan.mp4";
const key = process.env.MODEL_API_KEY;
if (!key) {
  console.error("MODEL_API_KEY is not set in the environment — refusing to run.");
  process.exit(2);
}

const client = new OpenAI({ apiKey: key, baseURL: "https://api.meta.ai/v1" });

const buf = readFileSync(MP4);
console.log(`uploading ${MP4} (${buf.length} bytes) with purpose user_data…`);
const uploaded = await client.files.create({
  file: await toFile(buf, "shelf-pan.mp4"),
  purpose: "user_data",
});
console.log(`file uploaded: id=${uploaded.id} status=${uploaded.status}`);

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
        // input_video is a Meta extension: the OpenAI SDK types do not
        // name it, so it is sent as a plain wire object.
        { type: "input_video", file_id: uploaded.id },
      ],
    },
  ],
});

const parsed = parseVideoStream(stream);
const result = await parsed.finalResult;
const latencyMs = Date.now() - started;
console.log(`outcome=${result.outcome?.status ?? "unknown"} latency=${latencyMs}ms`);
if (result.outcome?.status !== "completed") {
  console.error("video segmentation did not complete");
  process.exit(3);
}
const boxes = recordsOfKind(result.records, "box");
const masks = recordsOfKind(result.records, "mask");
console.log(`box records=${boxes.length} mask records=${masks.length}`);
const byObject = new Map();
const perFrame = new Map();
for (const b of boxes) {
  const f = frameIndexOf(b);
  if (!byObject.has(b.objectId)) byObject.set(b.objectId, []);
  byObject.get(b.objectId).push(f);
  perFrame.set(f, (perFrame.get(f) ?? 0) + 1);
}
console.log(`unique objectIds=${byObject.size}`);
for (const [id, frames] of [...byObject.entries()].sort()) {
  console.log(`  object ${id}: frames ${Math.min(...frames)}..${Math.max(...frames)} (${frames.length} sightings)`);
}
const frameCounts = [...perFrame.entries()].sort((a, b) => a[0] - b[0]);
console.log(`frames with boxes: ${frameCounts.map(([f, c]) => `${f}:${c}`).join(" ")}`);
const confs = boxes.map((b) => b.confidence ?? null);
console.log(`confidences: ${JSON.stringify(confs.slice(0, 12))}${confs.length > 12 ? " …" : ""}`);
if (result.diagnostics.length > 0) {
  console.log(`diagnostics: ${result.diagnostics.map((d) => d.code).join(", ")}`);
}
