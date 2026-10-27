# TASKS.md — RealitySync AI

Slices are vertical and demoable. Check a task off only when its acceptance criteria pass (tests + live check). Oct 31 is BLACKOUT (Paytm offline day) — no work that day.

## Slice 1 — Foundation + SAM probe (Oct 27)
- [x] S1.1 Repo + projects: `~/workspace/realitysync/` with `client/` + `server/`, public GitHub repo `pintu544/realitysync`, git identity Pintu Kumar <64580363+pintu544@users.noreply.github.com>. Done means: remote HEAD verified, tree clean, no secrets committed. — DONE 2026-10-27: remote HEAD fe0c98e (later 2nd commit, see below), tree clean, secret scan clean, repo PUBLIC.
- [x] S1.2 Meta key/credits verify: transient key read from the Meta goal's `hidden_files/.env` (never printed, stored, or committed); health-style probe confirms Meta API reachability. Done means: HTTP 200 evidence, no key material in any output. — DONE 2026-10-27: GET /v1/models → HTTP 200, sam-3.1 + muse-spark-1.3 listed. Evidence: spec/probe-evidence.md.
- [x] S1.3 One real SAM 3.1 segmentation: one real image (synthetic shelf image acceptable for the probe) → parsed SAM output with count + boxes. Done means: real API response saved as evidence (counts/boxes, no key), OR a clear failure report that stops the build. — DONE 2026-10-27: outcome completed, 6/6 boxes within ~1px, latency 2007ms. Evidence: spec/probe-evidence.md + spec/probe-shelf.png.
- [x] S1.4 QA gate (adversarial, fresh agent): probe evidence + scaffold reviewed; criticals fixed before Slice 2. — DONE 2026-10-27: verdict SAFE TO CLOSE, zero criticals (secrets clean, both builds green, health honest, HEAD verified, probe geometrically consistent). Condition carried into Slice 2: W1 probe script + redacted response first.

## Slice 2 — Dashboard + simulated ERP (Oct 28)
- [ ] S2.0 QA carry-over (do FIRST): commit a `probe/` script that reads the Meta key from env only and saves a redacted raw SAM response (record kinds, objectIds, bounds; mask rasters optional) next to probe-evidence.md, then re-run it once to prove the S1.3 gate is reproducible (QA W1). Also fix: server `dev` script via tsx (W3), Vite dev proxy `/api` → localhost:4000 (W4), add `server/.env.example` (I1), `.gitignore` `.env*` with `!.env.example` (I2).
- [ ] S2.1 Tables + migrations (inventory, scans, audit_cases, audit_events) + versioned fixtures (Shelf A-01 / BOX-RED / 12).
- [ ] S2.2 Upload UI + scan history + inventory view (Impeccable for UI). Done means: upload → scan record → history visible in browser.
- [ ] S2.3 QA gate.

## Slice 3 — SAM masks + count validation (Oct 29)
- [ ] S3.1 SAM detection wired to scans; numbered overlays rendered; counts validated against manual annotations on ≥5 images.
- [ ] S3.2 Coverage classification (full/partial/unknown) → needs_review path. Done means: occluded test image yields needs_review, not a confident count.
- [ ] S3.3 QA gate.

## Slice 4 — Video tracking (Oct 30; photo fallback decision point)
- [ ] S4.1 MP4 upload via Meta Files API (purpose user_data) + parseVideoStream; track IDs deduped across frames.
- [ ] S4.2 DECISION: if tracking is unreliable, cut to photo-only and record the cut in SPEC.md. Done means: decision documented + demo path still end to end.
- [ ] S4.3 QA gate.

## Slice 5 — Agentic investigation (Nov 1; shifted from Oct 31 blackout)
- [ ] S5.1 Deterministic ERP-vs-visible comparison; Muse Spark structured investigation from evidence only.
- [ ] S5.2 Audit case generation with recommendation JSON. Done means: 12-vs-9 case yields a reviewable case with safe_to_auto_update=false.
- [ ] S5.3 QA gate.

## Slice 6 — Approval + evaluation (Nov 1–2, compressed)
- [ ] S6.1 Approval screen + guarded correction (version check, atomic inventory + event update) + reject-with-reason.
- [ ] S6.2 20-scan evaluation; metrics page with actual numbers + failures shown. Done means: metrics are measured, not asserted.
- [ ] S6.3 QA gate.

## Slice 7 — Release candidate (Nov 3)
- [ ] S7.1 Azure single-service deploy (F1 free, Central India); live health + full upload→approval flow verified on the deployed URL.
- [ ] S7.2 Genuine captured outputs saved as labeled replay fallback; README distinguishes real Meta functionality vs mocked ERP vs incomplete features; architecture diagram.
- [ ] S7.3 Demo video script ready (Pintu records — Pintu-only step).

## Slice 8 — Submit (Nov 4)
- [ ] S8.1 Submission requirements checked in the participant portal; repo + demo + README + video verified.
- [ ] S8.2 Submit with hours of buffer before Nov 4 21:00 ET (Nov 5 07:30 IST). Done means: submission confirmed in the portal, not just claimed.
