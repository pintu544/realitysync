// Slice 4+ eval runner: uploads every image fixture in spec/eval through the
// real API, polls until analyzed/failed, and prints truth vs measured count.
// No secrets: the server holds the Meta key; this script only talks to
// localhost:4000. Usage: node spec/eval/run-eval.mjs [baseUrl]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] ?? "http://localhost:4000";
const truth = JSON.parse(readFileSync(join(HERE, "ground-truth.json"), "utf8"));

async function poll(id) {
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${BASE}/api/scans/${id}`);
    const row = await res.json();
    if (row.status !== "pending") return row;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { status: "TIMEOUT" };
}

for (const [file, expected] of Object.entries(truth)) {
  if (!/\.(png|jpg)$/i.test(file)) continue;
  const buf = readFileSync(join(HERE, file));
  const form = new FormData();
  form.append("media", new Blob([buf], { type: file.endsWith(".jpg") ? "image/jpeg" : "image/png" }), file);
  form.append("shelfId", "A-01");
  const res = await fetch(`${BASE}/api/scans`, { method: "POST", body: form });
  if (!res.ok) {
    console.log(`${file} | truth=${expected} | UPLOAD FAILED ${res.status}`);
    continue;
  }
  const { scanId } = await res.json();
  const row = await poll(scanId);
  const boxes = row.detections?.boxes?.length ?? null;
  const conf = row.detections?.boxes?.map((b) => b.confidence ?? null) ?? null;
  console.log(
    `${file} | truth=${expected} | status=${row.status} | visible=${row.visible_qty} | raw=${row.detections?.raw_box_count} | merged=${boxes} | coverage=${row.coverage_status} | latency=${row.detections?.latency_ms}ms | conf=${JSON.stringify(conf)}`,
  );
}
