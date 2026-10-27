# Slice 3 evaluation — SAM counts vs manual annotations (2026-10-27)

Method: every image was uploaded through the real API (`POST /api/scans`,
shelf A-01) and analyzed by the production code path (SAM 3.1 via the
Meta Model API, prompt "cardboard box", boxes merged per the DESIGN.md
vertical-split rule in round 2). Fixtures are synthetic shelf drawings in
`spec/eval/` with known ground truth; no real warehouse photos exist yet,
so these numbers measure SAM-on-synthetic, NOT real-world accuracy.

## Fixtures and ground truth

| Image | Truth | Notes |
|---|---|---|
| `eval-3.png` | 3 boxes | Well separated, flat boxes, tape line, no labels |
| `eval-5.png` | 5 boxes | Two rows, flat boxes, tape line, no labels |
| `eval-8.png` | 8 boxes | Two rows, flat boxes, tape line, no labels |
| `eval-occluded.png` | 5 physical, count uncertain | 1 box edge-clipped + 1 heavily occluded |
| `eval-empty.png` | 0 boxes | Planks only |
| `eval-3.jpg` | 3 boxes | Same layout as eval-3.png, JPEG-encoded |
| `eval-partial.png` | 6 physical (5 full + 1 edge-clipped) | Extra case for the partial branch, no labels |
| `eval-partial-labeled.png` | 6 physical (5 full + 1 edge-clipped) | Same layout, probe-style tape + centered label |
| `spec/probe-shelf.png` | 6 boxes | Slice 1 probe image (tape + labels) |

## Round 1 — raw SAM segments, no merging

| Image | Truth | SAM raw | Coverage | Verdict | Assessment |
|---|---|---|---|---|---|
| eval-3.png | 3 | 0 | unknown | needs_review | Count wrong, verdict safe (miss) |
| eval-5.png | 5 | 6 | full | confident | CONFIDENT WRONG (tape-line splits) |
| eval-8.png | 8 | 0 | unknown | needs_review | Count wrong, verdict safe (miss) |
| eval-occluded.png | uncertain | 0 | unknown | needs_review | REQUIRED VERDICT MET |
| eval-empty.png | 0 | 0 | unknown | needs_review | REQUIRED: zero never claimed confidently |
| eval-3.jpg | 3 | 6 | full | confident | CONFIDENT WRONG (tape-line splits) |

Finding: SAM split single flat boxes into stacked halves at the tape
line (halves share x-extent, touch vertically). That produced the two
confident over-counts. The vertical-split merge rule (DESIGN.md) was
written to correct exactly this artifact, deterministically.

## Round 2 — merged counts

| Image | Truth | Merged | Raw | Coverage | Verdict | Assessment |
|---|---|---|---|---|---|---|
| eval-3.png | 3 | 0 | 0 | unknown | needs_review | Miss, deterministic across reruns; verdict safe |
| eval-5.png | 5 | 5 | 6 | full | confident | Count RIGHT (boxes are partial-height bottom halves + one merged box — count right, boxes imperfect) |
| eval-8.png | 8 | 0 | 0 | unknown | needs_review | Miss; verdict safe |
| eval-occluded.png | uncertain | 0 | 0 | unknown | needs_review | REQUIRED VERDICT MET |
| eval-empty.png | 0 | 0 | 0 | unknown | needs_review | REQUIRED: zero never claimed confidently |
| eval-3.jpg | 3 | 3 | 6 | full | confident | Count RIGHT (6 segments merged to 3 full-height boxes) |
| probe-shelf.png (re-check) | 6 | 6 | 6 | full | confident | Unchanged by merge (no splits to merge) |

Exact-count accuracy, round 2, core synthetic set: 2/6 (eval-5,
eval-3.jpg); 3/7 including the probe image. Latencies 0.9–2.2s per scan.

## Partial-branch experiments (the key Slice 3 question)

- `eval-partial.png` (unlabeled): SAM found only 3 bottom-half boxes,
  missed the edge-clipped box entirely → count 3, coverage `full`,
  confident. This is the coverage heuristic's BLIND SPOT, stated plainly:
  a silently missed object leaves no signal, so coverage can read `full`
  on a wrong count. No counting rule can fix a miss; only better
  detection (or a second signal) can.
- `eval-partial-labeled.png` (same layout + probe-style labels): SAM
  found all 6 boxes with near-perfect full-height bounds, including the
  clipped box at the right border (1051–1200) → coverage `partial` →
  `needs_review`. The partial branch works end to end when SAM detects
  the edge object. Browser-verified: 6 numbered overlays aligned over
  the boxes + the needs-review banner.

Conclusion: SAM recall on these fixtures depends on texture/anchors.
Flat, label-less boxes are frequently missed or halved; probe-style
boxes (tape + centered label) are detected near-perfectly. Real
cardboard boxes have labels, tape, and texture, so synthetic-flat
accuracy UNDERSTATES expected real-photo performance — but that is an
inference, not a measurement. The Slice 6 twenty-scan evaluation on
REAL photos (still needed from Pintu) is what settles real accuracy.
Until then, no accuracy number from this page may be quoted as a
product claim.

## Slice 4 S4.0 re-verification (Slice 3 QA carry-over, 2026-10-27)

- W1 merge symmetry: DESIGN.md rule now checks vertical overlap in [-10, 2]px
  in either order. Unit checks: reversed-order halves merge (1), 3px overlap
  does not merge (2), side-by-side never merges (2). Eval re-run (run-eval.mjs):
  eval-5 → 5 (raw 6), eval-3.jpg → 3 (raw 6), all other fixtures identical to
  Slice 3 round 2 — no merged-count regression.
- W3 copy: full-coverage line now reads as what SAM saw in the photo, not
  proof of stock; DESIGN.md pins the same caveat for Slice 5+ audit wording.
- W4 in-flight guard: second analyze during an active run → 409
  "analysis already running" (verified live).
- W5 retry/refresh: poll-cap banner with Refresh status + Retry analysis
  buttons added for scans pending past 90s (browser verification with the
  Slice 4 client check).
- W6 confidence: `include_confidence: "true"` metadata added; probe image
  re-run returns 6 boxes with confidences ~0.74–0.75 stored in
  scan_detections (previously all null).
- W7 min-size filter: boxes below 0.1% of image area dropped before
  merging; unit check keeps a 200×200 box and drops a 10×10 sliver on a
  1200×800 frame; threshold documented in DESIGN.md.
- I1 unknown API route → JSON 404 (verified live). I2 truncated-PNG scan
  fails honestly with the Meta decode error, no path leak. I3 initial SELECT
  wrapped (no unhandled rejection path). I5 partial fixtures added to
  spec/eval/ground-truth.json (partial + partial-labeled, both 6 physical).
- Slice 2/3 error paths re-run live: no-file 400, wrong-MIME 415,
  unknown-shelf 404 with zero orphan files, unknown-scan 404, 26MB 413,
  spoof .html-as-PNG 415, valid PNG named evil.html saved as .png and
  served image/png + attachment + nosniff + sandbox, prod-without-
  DATABASE_URL exits 1, truncated-PNG async failure → failed/unknown.

- DOES: wire SAM into scans asynchronously; number overlays from merged
  boxes; coverage full/partial/unknown per the documented heuristic;
  needs_review surfaced for partial/unknown; empty never claimed as
  confident zero; occluded fixtures yield needs_review.
- DOES NOT: guarantee a count whenever SAM silently misses objects
  (blind spot above); identify SKUs; handle video (Slice 4).
