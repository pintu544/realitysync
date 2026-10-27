# RealitySync AI

Warehouse auditor that gives ERP systems eyes: SAM 3.1 counts visible cartons on a shelf photo/video, a deterministic compare checks the count against the simulated ERP record, Muse Spark investigates the discrepancy, and a human approves any correction.

Meta Global AI Developer Hackathon — Indie Dev Track, "Build for Your World".

## Status

Slice 1 (foundation + SAM probe) in progress. See `spec/` for the contract: `GRILL.md`, `SPEC.md`, `DESIGN.md`, `TASKS.md`, `research.md`.

## Layout

- `client/` — React + Vite + Tailwind frontend (skeleton).
- `server/` — Node.js + Express + TypeScript API (skeleton, `/api/health`).

## Run locally

```sh
cd server && npm install && npm run build && PORT=4000 node dist/index.js
cd client && npm install && npm run dev
```

Secrets come from the environment only (`MODEL_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`). Never commit a `.env` file.
