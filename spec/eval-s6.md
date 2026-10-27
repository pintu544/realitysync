# Slice 6 evaluation — 20+ scans, approval, denominator decision (2026-10-27)

Method: all 22 fixtures in `spec/eval/s6-manifest.json` uploaded through
the real API (server held the Meta key transiently; this harness only
talks to localhost), analyses + audit cases awaited, results written to
`server/eval-results.json` (served by `GET /api/metrics`). No approvals
were performed during the run — approving mid-run would move the A-01
expected quantity and corrupt later comparisons. All fixtures synthetic;
these numbers measure SAM-on-synthetic, NOT real-shelf accuracy.
Real-photo/video evaluation is still open, awaiting Pintu's photos.

## Results table (truth = physical boxes; null = count itself uncertain)

| File | Truth | Visible | Raw | Coverage | Review | Latency | Case action |
|---|---|---|---|---|---|---|---|
| eval-3.png | 3 | 0 | 0 | unknown | true | 8163ms | recount |
| eval-5.png | 5 | 5 | 6 | full | false | 6432ms | investigate_further |
| eval-8.png | 8 | 0 | 0 | unknown | true | 8064ms | recount |
| eval-3.jpg | 3 | 3 | 6 | full | false | 6834ms | investigate_further |
| eval-occluded.png | uncertain | 0 | 0 | unknown | true | 8136ms | investigate_further |
| eval-empty.png | 0 | 0 | 0 | unknown | true | 9228ms | investigate_further |
| eval-partial.png | uncertain | 3 | 3 | **full** | **false** | 9225ms | clearer_photo |
| eval-partial-labeled.png | uncertain | 6 | 6 | partial | true | 14322ms | recount |
| probe-shelf.png | 6 | 6 | 6 | full | false | 12309ms | investigate_further |
| stacked-row.png | 3 | 0 | 0 | unknown | true | 11514ms | recount |
| stacked-labeled.png | 3 | 0 | 0 | unknown | true | 13653ms | investigate_further |
| small-single.png | 1 | 0 | 0 | unknown | true | 7834ms | investigate_further |
| small-sparse.png | 4 | 4 | 4 | full | false | 13091ms | investigate_further |
| small-dense.png | 12 | 12 | 12 | full | false | 7786ms | none (clean match) |
| dense-12.png | 12 | 0 | 0 | unknown | true | 15721ms | investigate_further |
| dense-large.png | 12 | 0 | 0 | unknown | true | 11413ms | investigate_further |
| sparse-12.png | 12 | 0 | 0 | unknown | true | 9525ms | recount |
| labeled-12.png | 12 | 0 | 0 | unknown | true | 8281ms | investigate_further |
| shelf-pan.mp4 | 6 | 6 | 152 | partial | true | 11779ms | recount |
| shelf-pan-bar.mp4 | 6 | 7 | 168 | partial | true | 5872ms | recount |
| shelf-static.mp4 | 6 | 4 | 160 | partial | true | 11301ms | recount |
| shelf-pan-past.mp4 | 6 | 6 | 86 | partial | true | 10080ms | clearer_photo |

## Metrics (definitions pinned — read them before quoting any number)

- **Exact-confident accuracy: 5/19.** Visible == truth AND coverage ==
  full, over numeric-truth analyzed fixtures. The 5: eval-5, eval-3.jpg,
  probe-shelf, small-sparse, small-dense.
- **Count match (any coverage): 8/19.** The 5 above + eval-empty (0==0,
  unknown coverage), shelf-pan (6, partial), shelf-pan-past (6, partial).
- **Uncertain-flag recall: 2/3.** Occluded and partial-labeled flagged
  needs_review; eval-partial NOT flagged (see blind spot below).
- **Confident-wrong on numeric-truth fixtures: 0/19.** No numeric-truth
  fixture produced a confident (full-coverage) wrong count. **This does
  NOT mean "no confident errors": see the blind-spot case next.**
- **Blind spot, fired again: eval-partial.png reads confident 3 for 6
  physical boxes** (5 full + 1 edge-clipped, unlabeled). Coverage full,
  needs_review false — a confident wrong number with no signal, exactly
  the Slice 3 documented blind spot. It is excluded from the
  confident-wrong metric only because its truth is recorded as
  uncertain (occlusion); physically it is a confident miss. Any claim
  of "zero confident errors" that omits this row is dishonest.
- **Average SAM latency: image 10085ms, video 9758ms.** SAM latency
  only — total scan-to-case time is longer (Spark reasoning adds
  seconds; the race test in S6.0 saw cases land >8s after analysis).
- **Case creation: 22/22. Video→case live: 4/4.** The Slice 5
  structural fix (video early-return) is now verified live: every
  video scan produced an audit case.
- **Investigation actions:** recount 8, investigate_further 11,
  clearer_photo 2, none 1 (small-dense clean match: 12==12, no model
  call burned).

## Size vs density vs texture: NOT separated (open question, not a claim)

The fixture set was designed to separate the Slice 5 dense-miss cause.
It did not: small-dense (60px boxes, dense 6-per-row) scores 12/12
full, while dense-12 (135px, same layout) scores 0, dense-large
(190px, same layout) scores 0, sparse-12 (200px, spaced 3×4) scores 0,
and labeled-12 (dense-12 + labels) scores 0. No single factor — size,
density, labels, spacing — explains all five. Stacked boxes (3 tall,
5px gaps) also score 0 with and without labels, so the W2 stacking
ambiguity could not even be exercised (there was nothing to merge).
What IS consistent with Slice 3: flat unlabeled PNG boxes are
frequently missed entirely (eval-3.png, eval-8.png still 0 — not a
regression, same as Slice 3 round 2), while JPEG encoding of the same
layout (eval-3.jpg) scores 3/3 and small boxes score. Conclusion for
the demo: use known-good fixture styles only (probe-style labeled
shelves ≤9 boxes, or small boxes) and treat every other style as
unproven until real photos decide. Do not quote any synthetic accuracy
number as a product claim.

## Video findings

- **Denominator decision VALIDATED:** shelf-pan-past spans 22/40 frames
  (maxFrame 21, totalFrames 40, denominator "clip") → 22/40 = 0.55 <
  0.8 → partial. Under the old span denominator it would have read
  22/22 = full. Trailing dropout now reads partial, as designed. All
  four clips report denominator "clip" with totalFrames 40 (stts parse
  works on ffmpeg output).
- **Pan-bar over-counts: 7 tracked vs 6 physical** (occluder bar
  and/or a split track). Flagged partial, so the failure direction is
  safe (needs review, never a confident correction) — but video
  identity under occlusion is not perfect.
- **Static is NOT deterministically zero:** shelf-static.mp4 tracks 4/6
  (partial) this run, vs 0 twice in Slice 4 on a different static
  clip. Slice 4's "static returns nothing" was a single-scene artifact,
  exactly as Slice 4 QA warned — the softened UI copy ("in our test
  clips") was the right call. Motion still tracks best (pan 6/6).
- **W7 small-box filter validated:** small-single (30×30 = 900px² <
  960px² threshold) filtered to 0/unknown, as designed. The threshold
  question (genuine distant boxes near the cutoff) still needs a real
  photo with genuinely small boxes — synthetic 30px is a filter test,
  not a distance test.

## S6.0 verification (carried here, not in the table)

- Concurrent `/investigate` during the auto-creation Spark call →
  409 "investigation already running" (first attempt), exactly one
  case row afterwards. Guard works.
- Parse-retry preserved (stub returning invalid JSON → 2 calls);
  valid response → 1 call. No-key error is a plain SparkError, not a
  SparkParseError, so the new predicate cannot retry it (the old regex
  matched "missing" in the not-configured message).
- Approval + stale + reject verified live and at function level (see
  Slice 6 report): approve moves inventory 12→6, version 1→2, case
  snapshot preserved; second decision 409; stale version 409 with
  inventory untouched; transaction rollback restores inventory.

## Open / not measured here

- **Real warehouse photos/video from Pintu still needed.** The
  evaluation harness (`spec/eval/run-eval-s6.mjs`) is ready: drop real
  photos into the manifest and re-run; report real and synthetic sets
  separately, never merged.
- **Meta file-ID accumulation** (Slice 4 QA I4) still open: no
  documented Files API delete shape.
- **Video overlays** (Slice 4 QA I5) still open: video scans show count
  only, no outlines, unlike the photo path.
- **SAM behavior on 12-box and stacked layouts** is unexplained (see
  above) — demo fixtures must stay in known-good styles.
