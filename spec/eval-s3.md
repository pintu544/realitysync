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

## What Slice 3 does and does not guarantee

- DOES: wire SAM into scans asynchronously; number overlays from merged
  boxes; coverage full/partial/unknown per the documented heuristic;
  needs_review surfaced for partial/unknown; empty never claimed as
  confident zero; occluded fixtures yield needs_review.
- DOES NOT: guarantee a count whenever SAM silently misses objects
  (blind spot above); identify SKUs; handle video (Slice 4).
