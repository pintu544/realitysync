// Reproducible Slice 1 (S1.3) SAM gate probe — QA W1 carry-over.
// Reads the Meta key from the environment ONLY (MODEL_API_KEY).
// It never prints, logs, stores, or commits the key.
// Writes a REDACTED response next to spec/probe-evidence.md:
// record kinds, objectIds and bounds only — mask rasters are omitted.
//
// Usage (key read transiently, never typed into a file or command):
//   MODEL_API_KEY=$(grep '^MODEL_API_KEY=' <goal .env> | cut -d= -f2-) \
//     NODE_USE_ENV_PROXY=1 node sam-probe.mjs
//
// Exit code 0 = gate reproduced (completed + boxes found).
// Anything else = gate NOT reproduced; the build must stop and report.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { parseImageStream, recordsOfKind } from "@meta-sam/parser";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const IMAGE = join(REPO, "spec", "probe-shelf.png");
const OUT = join(REPO, "spec", "probe-response-redacted.json");

const key = process.env.MODEL_API_KEY;
if (!key) {
  console.error("MODEL_API_KEY is not set in the environment — refusing to run.");
  process.exit(2);
}

const imageB64 = readFileSync(IMAGE).toString("base64");
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
        {
          type: "input_image",
          image_url: `data:image/png;base64,${imageB64}`,
        },
      ],
    },
  ],
});

const parsed = parseImageStream(stream);
const result = await parsed.finalResult;
const latencyMs = Date.now() - started;

const boxes = recordsOfKind(result.records, "box").map((r) => ({
  objectId: r.objectId,
  bounds: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
}));
const masks = recordsOfKind(result.records, "mask").map((r) => ({
  objectId: r.objectId,
  bounds: r.bounds,
  // mask raster deliberately omitted (large binary data, not needed as evidence)
}));

const redacted = {
  probe: "realitysync S1.3 SAM gate (reproducibility re-run)",
  runAt: new Date().toISOString(),
  model: "sam-3.1",
  prompt: "cardboard box",
  image: "spec/probe-shelf.png",
  outcomeStatus: result.outcome?.status ?? null,
  latencyMs,
  counts: {
    boxRecords: boxes.length,
    maskRecords: masks.length,
  },
  boxes,
  masks,
};
writeFileSync(OUT, JSON.stringify(redacted, null, 2) + "\n");

console.log(`outcome: ${redacted.outcomeStatus}`);
console.log(`latencyMs: ${latencyMs}`);
console.log(`boxRecords: ${boxes.length}, maskRecords: ${masks.length}`);
console.log(`redacted response written to spec/probe-response-redacted.json`);

if (redacted.outcomeStatus !== "completed" || boxes.length === 0) {
  console.error("GATE NOT REPRODUCED: outcome not completed or no boxes found.");
  process.exit(1);
}
console.log("GATE REPRODUCED: one real SAM 3.1 segmentation, boxes found.");
