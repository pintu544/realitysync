// Slice 6 evaluation harness: uploads every manifest fixture through the
// real API (server holds the Meta key; this script only talks to
// localhost:4000), waits for analysis + audit case, and writes the
// measured results to server/eval-results.json (served by GET /api/metrics
// and rendered on the metrics page). No secrets here. All uploads go out
// first (analyses run concurrently server-side), then all are polled.
// NOTE: this harness performs NO approvals — approving mid-run would move
// the A-01 expected quantity and corrupt later comparisons.
// Usage: node spec/eval/run-eval-s6.mjs [baseUrl]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] ?? "http://localhost:4000";
const manifest = JSON.parse(readFileSync(join(HERE, "s6-manifest.json"), "utf8"));

function mimeFor(file) {
  if (/\.mp4$/i.test(file)) return "video/mp4";
  if (/\.jpg$/i.test(file)) return "image/jpeg";
  return "image/png";
}

async function upload(entry) {
  const buf = readFileSync(join(HERE, entry.file));
  const form = new FormData();
  form.append("media", new Blob([buf], { type: mimeFor(entry.file) }), basename(entry.file));
  form.append("shelfId", "A-01");
  const res = await fetch(`${BASE}/api/scans`, { method: "POST", body: form });
  if (!res.ok) return { ...entry, uploadError: res.status };
  const { scanId } = await res.json();
  return { ...entry, scanId };
}

async function poll(entry) {
  // Analyzed status lands BEFORE the audit case (case creation runs
  // after the row update), so wait for a case too — except failed scans,
  // which never get one. Spark calls are reasoning-heavy; budget 6 min.
  for (let i = 0; i < 180; i++) {
    const res = await fetch(`${BASE}/api/scans/${entry.scanId}`);
    const row = await res.json();
    if (row.status === "failed") return row;
    if (row.status === "analyzed" && row.audit_case) return row;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { status: "TIMEOUT" };
}

const uploaded = [];
for (const entry of manifest.entries) {
  const u = await upload(entry);
  console.log(`uploaded ${entry.file} -> ${u.scanId ?? `FAILED ${u.uploadError}`}`);
  uploaded.push(u);
}

const cases = [];
for (const u of uploaded) {
  if (!u.scanId) {
    cases.push({ ...u, status: "UPLOAD_FAILED" });
    continue;
  }
  const row = await poll(u);
  const rec = row.audit_case?.recommendation ?? null;
  const c = {
    file: u.file,
    kind: u.kind,
    truth: u.truth,
    uncertain: u.uncertain,
    status: row.status,
    visible: row.visible_qty ?? null,
    raw: row.detections?.raw_box_count ?? null,
    merged: row.detections?.boxes?.length ?? null,
    coverage: row.coverage_status ?? null,
    needs_review: row.needs_review ?? null,
    latency_ms: row.detections?.latency_ms ?? null,
    video_stats: row.detections?.video_stats ?? null,
    case_state: row.audit_case?.state ?? null,
    investigation_action: rec?.investigation?.recommended_action ?? null,
    investigation_error: rec?.investigation_error ?? null,
  };
  cases.push(c);
  console.log(
    `${c.file} | truth=${c.truth} | ${c.status} | visible=${c.visible} | raw=${c.raw} | merged=${c.merged} | ${c.coverage} | review=${c.needs_review} | ${c.latency_ms}ms | case=${c.case_state} | action=${c.investigation_action}`,
  );
}

// Metrics, defined honestly (see spec/eval-s6.md):
// - exactConfident: visible == truth AND coverage == full (confident AND right).
// - countMatch: visible == truth regardless of coverage.
// - uncertainFlagRecall: uncertain fixtures flagged needs_review.
// - confidentWrong: visible != truth AND coverage == full (the GRILL bar:
//   never a confident wrong number).
const numeric = cases.filter((c) => typeof c.truth === "number" && c.status === "analyzed");
const uncertain = cases.filter((c) => c.uncertain && c.status === "analyzed");
const analyzed = cases.filter((c) => c.status === "analyzed");
const imgLat = analyzed.filter((c) => c.kind === "image" && c.latency_ms != null).map((c) => c.latency_ms);
const vidLat = analyzed.filter((c) => c.kind === "video" && c.latency_ms != null).map((c) => c.latency_ms);
const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const actions = {};
for (const c of analyzed) {
  const a = c.investigation_action ?? "none";
  actions[a] = (actions[a] ?? 0) + 1;
}
const metrics = {
  n: cases.length,
  analyzed: analyzed.length,
  failed: cases.filter((c) => c.status !== "analyzed").length,
  exactConfident: {
    hit: numeric.filter((c) => c.visible === c.truth && c.coverage === "full").length,
    of: numeric.length,
  },
  countMatch: { hit: numeric.filter((c) => c.visible === c.truth).length, of: numeric.length },
  uncertainFlagRecall: {
    hit: uncertain.filter((c) => c.needs_review === true).length,
    of: uncertain.length,
  },
  confidentWrong: {
    hit: numeric.filter((c) => c.visible !== c.truth && c.coverage === "full").length,
    of: numeric.length,
    files: numeric.filter((c) => c.visible !== c.truth && c.coverage === "full").map((c) => c.file),
  },
  avgLatencyMs: { image: avg(imgLat), video: avg(vidLat) },
  caseCreationRate: {
    hit: analyzed.filter((c) => c.case_state).length,
    of: analyzed.length,
  },
  videoCaseLive: {
    hit: analyzed.filter((c) => c.kind === "video" && c.case_state).length,
    of: analyzed.filter((c) => c.kind === "video").length,
  },
  investigationActions: actions,
};
console.log("\nMETRICS", JSON.stringify(metrics, null, 2));

const out = {
  run: {
    date: new Date().toISOString(),
    label: "synthetic fixtures (spec/eval/s6-manifest.json)",
    note: "Synthetic-fixture evidence only — NOT real-shelf accuracy. Real-photo evaluation is still open, awaiting Pintu's photos.",
    n: cases.length,
  },
  metrics,
  cases,
};
writeFileSync(join(HERE, "..", "..", "server", "eval-results.json"), JSON.stringify(out, null, 2));
console.log("wrote server/eval-results.json");
