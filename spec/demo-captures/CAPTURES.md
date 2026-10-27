# Captured outputs — labeled replay fallback (Slice 7, S7.2)

These are genuine outputs captured from the running app, not mockups. If the
live demo fails on the day, these are the fallback evidence. Every capture
below says what it is, when it was taken, and what was real vs simulated.

## 2026-10-27-full-flow.png — full page, local dev server

- **Captured:** 2026-10-27 ~05:05 UTC (10:35 IST), Playwright headless shell
  against Vite dev (5173) + API dev (4000), pg-mem backend, real Meta API
  calls (SAM 3.1 + Muse Spark) with the project key.
- **What it shows, top to bottom:**
  1. Simulated ERP inventory: shelf A-01 / BOX-RED, expected 6, version 2
     (version 2 because the approval shown further down already landed).
  2. Selected scan media: `spec/probe-shelf.png` with 6 numbered SAM 3.1
     outlines, one per visible object counted.
  3. Comparison: ERP expected 6, visible 6, difference 0, coverage full,
     status analyzed, 6 boxes · 6 masks, 1.5 s analysis time.
  4. AI investigation panel: deterministic input labeled "computed by code
     — not by the model" (ERP 12, visible 6, difference −6, coverage full);
     the model summary states plainly that true stock and the reason for
     the difference remain unknown; recommended next step "Investigate
     further"; the safe_to_auto_update note.
  5. Approval note: "expected quantity set to 6 (was 12). The case snapshot
     above still shows the original numbers — the decision is a new fact,
     not an edit of the evidence."
  6. Scan history: the scan, analyzed, full, case approved, 6 / 6.
  7. Evaluation metrics: live aggregates (1 analyzed, 0 video, 1.5 s,
     approved: 1) + the last labeled harness run (synthetic fixtures,
     22 scans, 5/19 exact-confident, 8/19 count match, 2/3 uncertain-flag
     recall, 0/19 confident-wrong numeric-truth) + the amber caveat box
     naming eval-partial.png as a confident miss on uncertain truth, and
     the highlighted eval-partial.png row (uncertain truth, visible 3,
     full coverage).
- **Real vs simulated in this capture:** SAM counts, Spark investigation,
  and the approval mechanics are real. The ERP record is simulated (a
  database row, not a real ERP). The shelf photo is a synthetic fixture
  (`spec/probe-shelf.png`), not a real warehouse photo. The evaluation
  numbers are synthetic-fixture evidence only — never quote them as
  real-shelf accuracy.

## Verified live flow transcript (same session, API level)

- Upload `spec/probe-shelf.png` → scan created, analyzed: visible 6,
  coverage full.
- Audit case auto-created with a Muse Spark investigation (summary states
  true stock + reason UNKNOWN; no invented numbers).
- Approve with quantity 6 → inventory A-01: 12 → 6, version 1 → 2, case
  state approved, original snapshot preserved.
- POST `/api/scans/:id/investigate` on the decided case → identical
  recommendation, state still approved, inventory untouched at 6/v2
  (Slice 7 S7.0 guard, verified live).
- Error paths re-run in the same session: no-file 400, wrong-MIME 415,
  unknown-shelf 404 with zero orphan files, malformed scan id 400 with the
  server alive afterwards, unknown UUID 404, unknown route JSON 404,
  26 MB upload JSON 413, spoofed HTML-as-PNG 415 with no file left.

## What is NOT captured here (still open)

- A real warehouse photo/video flow (awaiting Pintu's photos).
- The deployed production URL (deploy blocked on DATABASE_URL — see
  TASKS.md S7.1 note). These captures are from the local dev server.
- Video overlays on video scans (count only, no outlines — open item).
