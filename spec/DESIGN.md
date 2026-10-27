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

- Sort boxes by (left, top) for determinism. Merge two boxes when their left edges AND
  right edges agree within 3% of image width, and they are vertically adjacent in
  EITHER order: their vertical overlap `min(bottom) - max(top)` lies in [-10, 2]px
  (a gap of up to 10px, or an overlap of up to 2px — the 2px edge jitter that broke
  the one-directional gap check in Slice 3 QA W1). Merge transitively until no pair
  qualifies; the merged box is the union of bounds and keeps the first objectId.
- The visible count and coverage are computed from MERGED boxes; the raw
  segment count is preserved as `raw_box_count` on the detection row for
  auditability. The UI draws merged boxes only (one outline per counted
  object).
- The rule merges only vertical splits with matching x-extent. It never
  merges side-by-side boxes, and it never hides a miss: images where SAM
  finds nothing still classify `unknown` (see round 1: flat PNG boxes
  missed entirely), and occlusion still classifies `partial` via the
  border/overlap signals above.

## Minimum box-size filter (Slice 4, documented before coding)

Before merging or counting, drop any SAM box whose area is below 0.1% of the
image area (width × height). Such slivers are segmentation noise, not cartons;
counting them inflates visible counts on textured shelves. The filter runs
before the vertical-split merge (a sliver never merges into a real box), and
`raw_box_count` still preserves the pre-filter SAM segment count so the
filtering is auditable. Threshold: 0.001 × width × height.

## UI copy rule (Slice 4, from Slice 3 QA W3)

Full coverage must read as "what SAM saw in this photo", NEVER as proof of
stock. The comparison panel's full-coverage line says the visible count is
observed, not a stock fact, and a recount or clearer photo remains the safe
check before any inventory change. Audit cases (Slice 5+) MUST carry the same
caveat in their wording: a case recommends an action on observed evidence,
it does not assert a stock truth.

## In-flight analysis guard (Slice 4)

One analysis run per scan at a time, enforced server-side with an in-memory
set of running scan ids. A second `POST /api/scans/:id/analyze` while a run
is active returns 409 ("analysis already running") instead of starting a
second Meta call for the same scan (which would double-charge and race the
detection row). The guard covers both the upload-triggered run and the
manual retry path.

## Muse Spark investigation (Slice 5, documented before coding)

Trigger: when a scan reaches `analyzed`, the server creates (or refreshes)
an audit case for it. Muse Spark runs only when the scan needs human
attention — visible count differs from ERP expected, or coverage is not
`full`. A clean full-coverage match still gets a case, but with
investigation `null` and the note "counts match; no investigation
needed" (no model call is burned on a non-discrepancy). Failed scans get
no case: there is no evidence to investigate.

Evidence envelope (computed by code, never by the model): shelf_id, sku,
expected_qty, visible_qty, difference (= visible − expected, computed
here), coverage_status, media_type (image/video), merged box count,
raw_box_count, mask_count, latency_ms, video_stats when video, and a
compact per-box summary (index, border-touch flag, confidence when
present). The model NEVER receives the media bytes — text evidence only
— and it NEVER recomputes, reorders, or overrides the deterministic
numbers. It explains and recommends; the backend counts.

Grounding rules (pinned — the prompt states them, the server enforces
what it can):
- Invent nothing: no fabricated stock numbers, no invisible objects, no
  guessed counts. Every finding must trace to a field of the envelope.
- What is NOT known is stated, not filled in: true stock, occluded
  contents, and why the ERP record differs are all unknown. A count
  that differs from ERP does not prove theft, misplacement, or a data
  error — those are hypotheses, labeled as such.
- Unknown → needs_review: when coverage is `partial`/`unknown`, or the
  evidence cannot support a conclusion, the case stays `needs_review`
  and the recommended action must be a safe one (recount, clearer
  photo, investigate further) — never an inventory change.
- Inconsistency is flagged, never smoothed over: if envelope fields
  disagree with each other (e.g. visible count vs box list length), the
  model must say so explicitly instead of picking a consistent story.
- The model proposes NO corrected quantity: the output schema has no
  quantity field. A corrected number can only come from a human approval
  (Slice 6), never from model text.
- `safe_to_auto_update` is computed by code and is ALWAYS `false` in
  Slice 5: no auto-update path exists yet, and Slice 6 defines the
  criteria under which it could ever become true. The model cannot set
  it. Case state stays `needs_review` in Slice 5 for the same reason.

Output schema (validated strictly in code; anything else is a failure):
`{ summary: string, findings: string[], recommended_action:
"recount" | "clearer_photo" | "accept_visible_for_review" |
"investigate_further" | "no_action", needs_review: boolean }`.
Server overrides: if coverage is not `full`, the case stays
`needs_review` even if the model says otherwise — the coverage rule
wins over model text.

Failure degradation (fail-closed): no key, API error, invalid JSON, or
schema failure after one parse retry → the case is still created, with
investigation `null` and an honest `investigation_error` note, state
`needs_review`. A missing investigation is never papered over with a
fabricated explanation.

Audit trail: `audit_cases.recommendation` stores `{ deterministic:
{expected_qty, visible_qty, difference}, evidence: <envelope>,
investigation: <model output> | null, investigation_error: string |
null, safe_to_auto_update: false }`, and every creation/refresh/failure
writes an `audit_events` row, so any case can be reproduced from its
stored evidence snapshot.

Endpoints: `GET /api/scans/:id` includes `audit_case` (or null).
`POST /api/scans/:id/investigate` re-runs investigation for an analyzed
scan with no (or failed) investigation — 404 unknown scan, 400 invalid
id, 409 pending/failed scan, 200 with the existing case when an
investigation already exists (idempotent, no second model call).

Token budget (measured 2026-10-27, do not shrink): muse-spark-1.3
spends most of its completion budget on reasoning tokens before emitting
content — a 2000-token cap was consumed entirely by reasoning (1998
tokens) with zero content tokens and finish_reason `length`. The
investigation call therefore uses max_tokens 12000, and a fence-strip +
one parse retry + server-log preview guard the JSON parse.

One case per scan: enforced by a unique index on
`audit_cases(scan_id)` (tolerant — a pre-existing database with
duplicates logs and continues) plus a re-check before insert and a
winner-takes-all fallback on insert conflict, because the Spark call
takes seconds and a concurrent `/investigate` request can otherwise
create a second case.

## API contracts
- `POST /api/scans` — upload media, start analysis → `{ scanId, status }`.
- `GET /api/scans` — list scans, newest first (Slice 2 addition for scan history).
- `GET /api/scans/:id` — progress, visible count, masks/evidence, audit case.
  Slice 3: also returns `detections` (boxes, mask_count, latency_ms,
  error) or null while unanalyzed, and `needs_review` (true unless
  coverage is `full`). Slice 5: also returns `audit_case` (the stored
  recommendation + state) or null when no case exists yet.
- `POST /api/scans/:id/investigate` — (Slice 5) re-run Muse Spark
  investigation for an analyzed scan with no (or failed) investigation;
  200 with the existing case when one already exists, 404 unknown scan,
  400 invalid id, 409 pending/failed scan.
- `POST /api/scans/:id/analyze` — (re-)run SAM analysis for a scan in
  `pending` or `failed` state; returns `{ scanId, status }` immediately
  and analyzes asynchronously. Refused (409) for already-`analyzed` scans,
  for scans with an analysis already running (Slice 4 in-flight guard),
  and (404) for unknown scans. Slice 4: video scans analyze via video
  tracking (no longer refused).
- `GET /api/inventory` — list all inventory records (Slice 2 addition for the inventory view).
- `GET /api/inventory/:shelfId` — expected inventory record.
- `POST /api/audits/:id/approve` — body `{ approvedQty }`; validates version, updates inventory + audit event atomically.
- `POST /api/audits/:id/reject` — body `{ reason }`; records rejection event.
- `GET /api/health` — `{ ok, provider: "meta", llmConfigured, metaConfigured, envWarning }` (same honesty shape as livedocs-meta). **Semantics (QA W2, pinned): `ok` is process health only; consumers MUST check `llmConfigured`/`metaConfigured`, not `ok`, to judge Meta readiness** — with all env vars missing, `ok` is still true and only the configured flags tell the truth.

## Video tracking (Slice 4, documented before verification)

Transport (verified live 2026-10-27, not from training data): the MP4 is
uploaded to Meta's Files API with purpose `user_data`; the returned
`file_id` is passed as an `input_video` part to `sam-3.1` via the
Responses API. The OpenAI SDK types do not name `input_video` — it is a
Meta extension sent as a plain wire object. The stream is parsed with
`parseVideoStream`; box records carry `frame: { frameIndex }` and an
`objectId` that is stable across frames of one response (parser
contract), so the counted set is the unique objectIds, never the
per-frame box total. One tracked object counts once, however many frames
show it.

Frame size comes from the MP4 itself (`tkhd` width/height — box records
do not carry frame dimensions). Representative boxes (each object's
first-seen frame box) are stored in `scan_detections.boxes`; frame
statistics live in the `video_stats` JSONB column (frames with boxes,
max frame, unique objects). Per-frame tape-split merging is NOT applied
to video: the tracker's identity is the count signal, and merging
first-seen boxes from different objects could collapse distinct shelf
neighbors. A video split inflating the unique count is a Slice 6 eval
watch item.

Video coverage (same consequences as images — only `full` is confident):
`unknown` when zero objects are tracked; `partial` when boxes appear in
<80% of frames up to the max observed frame, or a representative box
touches a border (2%) or heavily overlaps (IoU > 0.5); otherwise `full`.

Denominator note (Slice 4 QA fix round): the <80% rule's denominator is
`maxFrame + 1` — frames spanned by detections, NOT clip length. A clip
whose tracking dies halfway and never recovers (boxes in frames 0–19 of a
40-frame clip) still reads `full` (20/20). Slice 6 decides whether to use
total clip frames (MP4 duration/fps) instead; until then the gap is
documented here, not papered over.

MEASURED LIMITATION (probe evidence, spec/eval-s4.md): SAM video
tracking needs camera motion. A slow-pan clip tracks 6/6 objects with
stable ids across runs; a fully static clip returns zero detections
twice, and a static clip with a moving occluder bar also returns zero.
With motion + occlusion, identity holds (6 unique ids, no duplicates,
per-frame dips to 4–5 at occlusion moments). Consequences, all
implemented: zero-box video = `unknown` → `needs_review`, never zero
stock; the UI advises a slow pan and says plainly that a static shot can
return nothing. The demo video MUST be a slow pan, not a static shot.

## Key decisions
- Deterministic counts, LLM explanations: the backend counts, Muse Spark only explains — so a wrong model sentence can never corrupt a number.
- Photo-first, video as enhancement: Slice 4 evidence refines this — video
  tracking identity HOLDS under occlusion when the camera moves (6 stable
  ids, no duplicates), but a fully static clip returns zero detections;
  video is kept, photo remains the fallback, and the demo video must be a
  slow pan (spec/eval-s4.md).
- Azure single service over blueprint's Vercel+Render: one URL, $0, proven deploy path (az rest full-list PUT; ARM GET lies; az CLI appsettings fails via proxy 411).
- Impeccable for all UI work (standing rule); Humanizer for submission/README prose.
- No Redis/BullMQ unless the simple worker proves insufficient (rejected: extra infra for a demo).

## Risks
1. **SAM 3.1 access on this key is unverified** — de-risk: Slice 1 probe (one real image → one real segmentation) before any feature code; stop and report on failure.
2. **SAM count accuracy on real photos** — de-risk: validate against manual annotations; 20-scan evaluation with failures published, not hidden.
3. **Video track identity under occlusion** — de-risk: photo-first fallback; occlusion → needs_review.
4. **Meta credit burn** — de-risk: cap scan volume in demo, cache genuinely captured outputs as transparently labeled replay fallback only.
