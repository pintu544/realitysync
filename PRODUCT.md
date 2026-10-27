# Product

<!-- impeccable:product-schema 1 -->

<!-- NOTE: written by a subagent from the explicit project brief
     (spec/SPEC.md, spec/DESIGN.md, spec/GRILL.md) with no interview
     channel to the user. Every fact below is taken from those files;
     anything not in them is marked ASSUMED, not confirmed. -->

## Platform

web

## Users
- Warehouse manager: uploads a shelf photo or short video, reviews a
  visible-vs-ERP discrepancy, and approves or rejects the correction.
  Works at a desk in a bright warehouse office, checking one shelf at a
  time between physical counts.
- Hackathon judge (Meta Indie track): opens the demo, watches one real
  scan travel from media to approved audit event, and reads measured
  accuracy numbers.

## Product Purpose
Warehouse ERP systems know what *should* be on a shelf but not what
*is* on it. Reconciliation is manual, slow, and error-prone. RealitySync
gives the ERP eyes: it counts what a camera can actually see, compares
it with the ERP record, and turns any mismatch into a human-reviewed
audit — never an automatic inventory change. Success is one 2-minute
demo, end to end, with real model output, plus measured accuracy over
20 labeled scans.

## Positioning
The mechanism a neighboring product cannot truthfully copy: deterministic
counting from vision output plus a guarded, human-approved correction.
The backend counts; the language model only explains. A visible count is
never presented as true stock: occlusion or partial coverage yields
`needs_review`, never a confident wrong number.

## Operating Context
- One shelf, one known SKU, clearly visible cartons first (demo case:
  Shelf A-01, SKU BOX-RED, ERP expected 12).
- Media: shelf photo (PNG/JPG) or 10–15 second video (MP4).
- Single core screen: media + masks on the left, comparison + AI
  explanation on the right, approval/audit panel below.
- Demo data is a simulated ERP (PostgreSQL in production, pg-mem in
  local dev only); no real ERP integration, no user authentication.

## Capabilities and Constraints
- Upload → scan record → scan history; scan progress, count, and
  evidence per scan.
- SAM 3.1 detection with numbered outlines; Muse Spark investigation
  as structured JSON from evidence only.
- Approval validates the inventory version and applies the correction
  atomically with the audit event; every approve/reject is recorded.
- Secrets only via environment; no key in repo, logs, or client bundle.
- Single-service deployment, $0 hosting (Azure F1 free tier).
- ASSUMED: judge and manager are the only audiences; no mobile-first
  requirement beyond a responsive single screen.

## Brand Commitments
- Name: RealitySync AI. Tagline used in the blueprint: "Giving ERP
  Systems Eyes."
- Honesty rule: label genuinely captured model output vs mocked ERP
  data vs incomplete features; never present a target as a result.

## Evidence on Hand
- Demo case: Shelf A-01 / BOX-RED / expected 12 (fixtures/seed.json).
- Slice 1 probe: synthetic shelf image (spec/probe-shelf.png) segmented
  6/6 by real SAM 3.1; redacted response in
  spec/probe-response-redacted.json.
- Absent: real warehouse photos (Pintu records test images); 20-scan
  evaluation (Slice 6); demo video (Pintu records).

## Product Principles
1. The human decides; the machine only evidences.
2. A visible count is not a stock count — uncertainty is a first-class
   result, not a failure mode.
3. Measured beats asserted: publish failures alongside accuracy.
4. One screen, one flow: upload → see → compare → decide.
