# RealitySync AI

Warehouse auditor that gives ERP systems eyes: SAM 3.1 counts visible cartons on a shelf photo/video, a deterministic compare checks the count against the simulated ERP record, Muse Spark investigates the discrepancy, and a human approves any correction.

Meta Global AI Developer Hackathon — Indie Dev Track, "Build for Your World".

## Status

Slice 3 done (SAM 3.1 wired to scans with async analysis, numbered overlays, coverage full/partial/unknown → needs_review, vertical-split merge, validated on 8 synthetic cases in `spec/eval-s3.md` — including the documented blind spot that SAM silently missing flat boxes can still read `full`). Slice 4 next: video tracking (photo fallback decision point). See `spec/` for the contract: `GRILL.md`, `SPEC.md`, `DESIGN.md`, `TASKS.md`, `research.md`.

## Layout

- `client/` — React + Vite + Tailwind frontend.
- `server/` — Node.js + Express + TypeScript API (`/api/health`, inventory, scans).

## Run locally

```sh
cd server && npm install && npm run build && PORT=4000 node dist/index.js
cd client && npm install && npm run dev
```

Secrets come from the environment only (`MODEL_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`). Never commit a `.env` file.
