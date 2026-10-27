# DESIGN.md — RealitySync AI

## Architecture
Single service. `client/` (React + Vite + Tailwind) uploads media and renders the one core screen: media + masks on the left, comparison + AI explanation on the right, approval/audit panel below. `server/` (Node + Express + TypeScript) owns scans, Meta calls, deterministic comparison, and guarded approval, and serves the client dist in production. A simple Node worker processes scans asynchronously so the UI never blocks. PostgreSQL holds the simulated ERP + audit trail. Meta Model API (`https://api.meta.ai/v1`) provides sam-3.1 (vision) and muse-spark-1.3 (reasoning). SAM and ERP lookups run independently before comparison.

## Data model
- `inventory`: id UUID PK, sku TEXT NOT NULL, shelf_id TEXT NOT NULL, expected_qty INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1.
- `scans`: id UUID PK, inventory_id UUID FK, media_url TEXT NOT NULL, visible_qty INTEGER, coverage_status TEXT DEFAULT 'unknown', status TEXT DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT NOW().
- `audit_cases`: id UUID PK, scan_id UUID FK, recommendation JSONB, state TEXT DEFAULT 'needs_review', approved_qty INTEGER, created_at TIMESTAMPTZ DEFAULT NOW().
- `audit_events`: id UUID PK, case_id UUID FK, action TEXT NOT NULL, details JSONB, created_at TIMESTAMPTZ DEFAULT NOW().
- Seed fixtures in `fixtures/` (Shelf A-01, SKU BOX-RED, expected 12 — the demo case) with a documented refresh contract.
- **Dev database decision (Slice 2, documented before coding):** local Postgres is unavailable on the dev VM (no server installed, no Docker). When `DATABASE_URL` is set, the server uses real PostgreSQL via `pg` — this is the production/Azure path and the only path that persists. When `DATABASE_URL` is unset, the server uses `pg-mem` (in-memory, pg-compatible) for **DEV ONLY**: same schema, same migrations, data resets on restart. The pg-mem fallback must never be used in production; production requires `DATABASE_URL`. This keeps Slice 2 demoable without a Postgres server while keeping the schema identical.

## Coverage classification (Slice 3, documented before coding)

SAM returns detections, not truth. The server classifies every analyzed
image scan into exactly one coverage state, and only `full` ever yields a
confident visible count:

- `unknown` — SAM call failed, outcome not `completed`, or zero
  detections. Zero detections cannot distinguish an empty shelf from a
  missed detection, so it is never read as "shelf is empty".
- `partial` — outcome `completed` with ≥1 detection, AND at least one
  detectable uncertainty signal: a box touching an image border (within
  2% of width/height — the object may extend beyond the frame), or two
  boxes overlapping with IoU > 0.5 (separation between objects is
  ambiguous, e.g. occlusion).
- `full` — outcome `completed` with ≥1 detection, no border-touching box,
  no heavy overlap.

Consequences (pinned): `partial` or `unknown` ALWAYS surface as
`needs_review` in the UI and in the comparison panel — the visible count
is shown as observed, never as a confident fact, and it MUST NOT feed any
inventory correction. Corrections do not exist until Slice 6, and even
then only a human approval applies one. A count that differs from ERP
expected does NOT by itself change coverage: mismatch + `full` = a
confident discrepancy; mismatch + `partial`/`unknown` = `needs_review`.
Video (MP4) scans stay `pending`/`unknown` in Slice 3 — video tracking
is Slice 4, and a pending video scan is never presented as analyzed.

Detection storage: a `scan_detections` table (scan_id PK/FK, boxes JSONB,
mask_count, latency_ms, error TEXT, analyzed_at) holds SAM evidence per
scan; the `scans` row carries visible_qty, coverage_status, and status
(`pending` → `analyzed` | `failed`). Keeping detections in their own
table avoids an ALTER TABLE migration that pg-mem may not support, and
keeps the Slice 2 `scans` shape intact.

## Deterministic counting: vertical-split merge (Slice 3, documented before coding)

Eval round 1 (spec/eval-s3.md) showed SAM splitting single flat boxes
into stacked halves at the tape line: each half shares the box's x-extent
and touches the next half vertically. Counting raw segments therefore
over-counts (eval-3.jpg: 6 segments for 3 boxes; eval-5: 6 for 5). The
counting rule corrects exactly this artifact, deterministically:

- Sort boxes by (left, top). Merge two boxes when their left edges AND
  right edges agree within 3% of image width, and they are vertically
  stacked with a gap between −2px (tiny overlap) and 10px (touching).
- Merge transitively until no pair qualifies; the merged box is the union
  of bounds and keeps the first objectId.
- The visible count and coverage are computed from MERGED boxes; the raw
  segment count is preserved as `raw_box_count` on the detection row for
  auditability. The UI draws merged boxes only (one outline per counted
  object).
- The rule merges only vertical splits with matching x-extent. It never
  merges side-by-side boxes, and it never hides a miss: images where SAM
  finds nothing still classify `unknown` (see round 1: flat PNG boxes
  missed entirely), and occlusion still classifies `partial` via the
  border/overlap signals above.

## API contracts
- `POST /api/scans` — upload media, start analysis → `{ scanId, status }`.
- `GET /api/scans` — list scans, newest first (Slice 2 addition for scan history).
- `GET /api/scans/:id` — progress, visible count, masks/evidence, audit case.
  Slice 3: also returns `detections` (boxes, mask_count, latency_ms,
  error) or null while unanalyzed, and `needs_review` (true unless
  coverage is `full`).
- `POST /api/scans/:id/analyze` — (re-)run SAM analysis for a scan in
  `pending` or `failed` state; returns `{ scanId, status }` immediately
  and analyzes asynchronously. Refused (409) for already-`analyzed` scans
  and (404) for unknown scans. Video scans are refused (409) in Slice 3:
  video tracking is Slice 4.
- `GET /api/inventory` — list all inventory records (Slice 2 addition for the inventory view).
- `GET /api/inventory/:shelfId` — expected inventory record.
- `POST /api/audits/:id/approve` — body `{ approvedQty }`; validates version, updates inventory + audit event atomically.
- `POST /api/audits/:id/reject` — body `{ reason }`; records rejection event.
- `GET /api/health` — `{ ok, provider: "meta", llmConfigured, metaConfigured, envWarning }` (same honesty shape as livedocs-meta). **Semantics (QA W2, pinned): `ok` is process health only; consumers MUST check `llmConfigured`/`metaConfigured`, not `ok`, to judge Meta readiness** — with all env vars missing, `ok` is still true and only the configured flags tell the truth.

## Key decisions
- Deterministic counts, LLM explanations: the backend counts, Muse Spark only explains — so a wrong model sentence can never corrupt a number.
- Photo-first, video as enhancement: video tracking identity breaks under full occlusion; if unreliable by Oct 30, photo ships.
- Azure single service over blueprint's Vercel+Render: one URL, $0, proven deploy path (az rest full-list PUT; ARM GET lies; az CLI appsettings fails via proxy 411).
- Impeccable for all UI work (standing rule); Humanizer for submission/README prose.
- No Redis/BullMQ unless the simple worker proves insufficient (rejected: extra infra for a demo).

## Risks
1. **SAM 3.1 access on this key is unverified** — de-risk: Slice 1 probe (one real image → one real segmentation) before any feature code; stop and report on failure.
2. **SAM count accuracy on real photos** — de-risk: validate against manual annotations; 20-scan evaluation with failures published, not hidden.
3. **Video track identity under occlusion** — de-risk: photo-first fallback; occlusion → needs_review.
4. **Meta credit burn** — de-risk: cap scan volume in demo, cache genuinely captured outputs as transparently labeled replay fallback only.
