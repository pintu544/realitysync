# Slice 5 evaluation — Muse Spark investigation from evidence only (2026-10-27)

Method: every case below ran through the real server code path (upload →
SAM analysis → automatic audit-case creation), except the adversarial and
clean-match cases, which call the investigation / case functions directly
and are labeled as such. The Meta key was used transiently from the
environment only, never stored or printed. No real warehouse photos exist
yet — all image evidence is synthetic, so these results validate the
investigation machinery and grounding, NOT real-world accuracy.

## The 12-vs-9 demo case (end to end, the TASKS.md S5.2 acceptance case)

- Input: probe-style labeled shelf image, 9 boxes (5 top + 4 bottom,
  varied sizes, thin tape lines, blank labels — `/tmp/shelf-9b.png`,
  not committed; generator pattern matches `spec/probe-shelf.png`).
- SAM: 9/9 boxes, coverage `full`, latency 1733 ms.
- Deterministic comparison (computed by code): ERP 12, visible 9,
  difference −3.
- Audit case: auto-created after analysis. `safe_to_auto_update:
  false`, state `needs_review`, case-level `needs_review: true`.
- Investigation (muse-spark-1.3, verbatim summary): "Shelf A-01
  (BOX-RED) shows expected_qty 12 versus visible_qty 9 (difference −3)
  with full image coverage; true stock and reason for the difference
  are UNKNOWN." Findings trace to envelope fields (counts match,
  border flags all false, confidence range 0.664–0.683, latency 1733).
  Recommended action: `investigate_further`. No invented numbers, no
  cause claimed as fact, no proposed quantity. PASS.

## Occluded / unknown case (end to end)

- Input: `spec/eval/eval-occluded.png` (1 edge-clipped + 1 heavily
  occluded box). SAM: 0 boxes → coverage `unknown`, visible 0.
- Investigation summary: "ERP expects 12 units … while segmentation
  saw 0 (visible_qty 0, difference −12). True stock and reason for
  the difference remain unknown, with coverage_status unknown."
  Recommended action: `recount`. It did NOT claim the shelf is empty
  and did NOT invent a count. PASS.
- Same behavior on the dense 12-box image below (SAM 0 → unknown →
  investigate_further, "camera-observed count, not confirmed true
  stock"). PASS.

## Failed scan case (end to end)

- Input: truncated PNG (first 100 bytes). Scan status `failed`,
  visible `null`, audit_case `null`. No case is created without
  evidence. PASS. (A failed investigation is also retryable via
  `POST /api/scans/:id/investigate`; pending/failed scans answer 409
  on that endpoint, unknown scans 404, invalid ids 400 — all verified.)

## Clean-match case (function-level, no model call)

- A synthetic analyzed scan (visible 12 = expected 12, coverage
  `full`) fed to `ensureAuditCase` with NO key in the environment:
  case created with note "counts match; no investigation needed",
  investigation `null`, `safe_to_auto_update: false`, state
  `needs_review`, recommendation-level `needs_review: false` (the
  workflow state stays `needs_review` in Slice 5 because no approval
  transition exists yet — the two fields answer different questions).
  Proves the clean-match branch burns no model call. PASS.

## Adversarial case — inconsistent envelope (function-level, live model)

- Envelope fed directly to `investigateDiscrepancy`: expected 12,
  visible 5, difference −3 (wrong — should be −7), box_count 7 with 7
  boxes listed (visible says 5). The model flagged BOTH
  inconsistencies explicitly ("Reported difference −3 is inconsistent
  with reported expected_qty and visible_qty"; "visible_qty 5 does
  not match box_count 7…"; "boxes list contains 7 entries, which does
  not match visible_qty 5"), recommended `investigate_further`,
  `needs_review: true`. It did NOT smooth the numbers into a
  consistent story. PASS.

## Bugs found and fixed during Slice 5 (all verified after the fix)

1. **Reasoning-token cap (critical to the slice):** the first live
   investigation failed with "LLM did not return valid JSON" — because
   muse-spark-1.3 spent the whole 2000-token budget on reasoning
   (1998 reasoning tokens, 0 content tokens, finish_reason `length`).
   Fix: max_tokens 12000 (documented in DESIGN.md as a measured floor,
   do not shrink), plus markdown-fence stripping, one parse retry, and
   a server-log-only preview on parse failure. After the fix, the
   12-vs-9 investigation returned on the first call.
2. **Video scans never got audit cases:** `runAnalysisInner` returned
   early after `runVideoAnalysis`, skipping the case-creation block
   that follows the try/catch. Fix: if/else so both paths fall
   through to case creation. (Video-case creation itself is now
   structurally covered; a live video→case run is a Slice 6 check.)
3. **Duplicate-case race:** the Spark call takes seconds, so a
   concurrent `/investigate` request could insert a second case for
   one scan. Fix: unique index on `audit_cases(scan_id)` (tolerant
   migration — a pre-existing database with duplicates logs and
   continues), a re-check before insert, and a winner-takes-all
   fallback on insert conflict. Duplicate-insert rejection verified
   against pg-mem; endpoint idempotency verified (existing
   investigation is returned, no second model call).

## S5.0 — 409-path auto-resume (browser-verified, stub API)

Playwright headless shell via raw CDP against Vite dev + a stub API
holding one scan pending: the 90s banner appeared on schedule; Retry
analysis hit the stub's 409 exactly once; the notice "Analysis already
running" appeared; the banner disappeared (polling restarted via the
pollCycle bump); the stub was then flipped to analyzed and the UI
updated to "Full coverage" with NO page reload (window marker intact).
PASS. The pre-existing Slice 4 success-path retry behavior is
unchanged.

## Error paths re-run (all pass)

No-file 400, wrong-MIME 415, unknown-shelf 404 with zero orphans,
unknown-scan 404, malformed scan id 400 with server alive, unknown API
route JSON 404, 27 MB upload JSON 413, spoof HTML-as-PNG 415, valid
PNG named evil.html saved as `.png` and served `image/png` +
attachment + nosniff + sandbox CSP, pending-scan `/investigate` 409,
prod without `DATABASE_URL` exits 1 (from Slice 4, unchanged code path).

## Impeccable detector

Live-page scan of the dev server (investigation panel rendered with a
real case): 0 findings, exit 0. The `.tsx` regex-only scan also
reports 0 findings but explicitly undercounts — the live-page result
is the one that counts.

## Open / not measured here

- **Dense-layout SAM miss:** a 12-box probe-style image (6 per row,
  ~135 px wide boxes) returned 0 detections. Small/dense synthetic
  boxes fail where 5-per-row probe-style boxes succeed (6/6, 9/9).
  Whether this is a size, density, or texture effect is unseparated —
  carried to Slice 6 as a fixture question (dense-row + small-box
  fixtures), NOT as a claim about real shelves.
- **Real warehouse photos/video from Pintu still needed for Slice 6.**
  Every accuracy-adjacent number above is synthetic-fixture evidence.
- **Video→case end-to-end** (video scan producing an audit case) was
  fixed structurally but not run live in this slice — Slice 6 check.
- **Meta file-ID accumulation** (QA I4, Slice 4) still open: no
  documented Files API delete shape, so uploaded video files are not
  deleted after analysis.
