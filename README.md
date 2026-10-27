# RealitySync AI

Warehouse auditor that gives ERP systems eyes: SAM 3.1 counts visible cartons on a shelf photo/video, a deterministic compare checks the count against the simulated ERP record, Muse Spark investigates the discrepancy, and a human approves any correction.

Meta Global AI Developer Hackathon — Indie Dev Track, "Build for Your World".

## Status

Slices 1–6 done and QA-closed (each with a fresh adversarial QA gate).
Slice 7 (release candidate) in progress: S7.0 QA carry-over done
(decided cases immutable to re-investigation; metrics blind-spot caveat).
Deploy (S7.1) is BLOCKED on a production `DATABASE_URL` — see TASKS.md.
Captured demo outputs: `spec/demo-captures/CAPTURES.md`. See `spec/` for the
contract: `GRILL.md`, `SPEC.md`, `DESIGN.md`, `TASKS.md`, `research.md`.

## What is real, what is simulated, what is incomplete

- **Real Meta functionality:** SAM 3.1 segmentation (photo + video
  tracking) and Muse Spark investigation, both via the Meta Model API
  (`https://api.meta.ai/v1`), verified live against synthetic fixtures.
- **Mocked ERP:** the "ERP record" is a simulated inventory table in the
  app's own database, seeded with shelf A-01 / BOX-RED / 12. Approvals
  change this simulated record only — never true stock, never a real ERP.
- **Incomplete / open items:** production deploy (blocked on
  `DATABASE_URL`); real-photo/video evaluation (awaiting real warehouse
  photos — all accuracy numbers to date are synthetic-fixture evidence
  only and must never be quoted as real-shelf accuracy); uploaded Meta
  video files are not deleted after analysis (no documented Files API
  delete shape); video scans show a count but no numbered overlays.
- **Known honest limits:** SAM can silently miss objects, and a silent
  miss leaves no signal — a confident count can still be wrong (see the
  eval-partial.png blind-spot case in `spec/eval-s6.md` and the caveat on
  the metrics page). Coverage `full` means "what SAM saw in this photo",
  not proof of stock.

## Layout

- `client/` — React + Vite + Tailwind frontend.
- `server/` — Node.js + Express + TypeScript API (`/api/health`, inventory, scans).

## Run locally

```sh
cd server && npm install && npm run build && PORT=4000 node dist/index.js
cd client && npm install && npm run dev
```

Secrets come from the environment only (`MODEL_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`). Never commit a `.env` file.
