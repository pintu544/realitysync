# SPEC.md — RealitySync AI

## Problem
Warehouse ERP systems know what *should* be on a shelf but not what *is* on it. Reconciliation is manual, slow, and error-prone. RealitySync gives the ERP eyes: it counts what a camera can actually see, compares it with the ERP record, and turns any mismatch into a human-reviewed audit — never an automatic inventory change.

## Users
- Warehouse manager: uploads a shelf photo/video, reviews discrepancies, approves or rejects corrections.
- Hackathon judge: opens the demo, watches one real scan go from media to approved audit event, reads measured accuracy.

## Functional requirements
1. The system SHALL accept a shelf photo (PNG/JPG) or short video (MP4, 10–15s) upload and create a scan record.
2. The system SHALL run SAM 3.1 detection on the media and display numbered outlines over each detected visible object.
3. The system SHALL compute the visible count deterministically from SAM output (dedupe by object/track ID), never from LLM output.
4. The system SHALL compare the visible count against the seeded ERP expected quantity for that shelf and report missing, excess, or uncertain stock.
5. The system SHALL classify coverage (full / partial / unknown); partial or unknown coverage SHALL yield `needs_review`, never a confident correction.
6. The system SHALL pass only structured evidence (shelf, SKU, expected qty, visible qty, coverage, detection method) to Muse Spark and SHALL return its investigation as structured JSON (summary, risk, possible causes, recommended action, safe_to_auto_update=false).
7. The system SHALL show original media, AI masks, the audit ticket, and an approve/reject control; approval SHALL apply the ERP correction atomically with the audit event and only after a version check.
8. The system SHALL record every approve/reject as an immutable-style audit event.
9. The system SHALL keep scan history and expose scan progress, count, and evidence per scan.
10. The system SHALL report measured evaluation metrics over 20 labeled scans (exact-count accuracy, % correctly flagged for review, average scan time) — actual numbers only, never targets presented as results.

## Non-functional
- One scan completes end to end or reports an honest failure state with progress; no silent hangs.
- No LLM call may mutate inventory; all mutations go through the guarded approval endpoint.
- Single-service deployment, $0 hosting (Azure F1 free tier).
- Secrets only via environment; no key in repo, logs, or client bundle.

## Out of scope
Multi-warehouse/multi-SKU operation; SKU identification from segmentation; real ERP integration; user authentication; Redis/BullMQ queue; automatic inventory updates; any feature not demoable in the 2-minute storyboard.

## Judging criteria map
Impact → R1–R4 (one concrete warehouse problem, visible-vs-ERP gap). Meta AI Tooling → R2, R6 (SAM 3.1 + Muse Spark only, via Meta Model API). Technical Depth → R3–R5, R7–R8 (deterministic compare, guarded approval, audit trail). Demo → R1–R10 as one flowing storyboard.
