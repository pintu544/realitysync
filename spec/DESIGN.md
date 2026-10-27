# DESIGN.md — RealitySync AI

## Architecture
Single service. `client/` (React + Vite + Tailwind) uploads media and renders the one core screen: media + masks on the left, comparison + AI explanation on the right, approval/audit panel below. `server/` (Node + Express + TypeScript) owns scans, Meta calls, deterministic comparison, and guarded approval, and serves the client dist in production. A simple Node worker processes scans asynchronously so the UI never blocks. PostgreSQL holds the simulated ERP + audit trail. Meta Model API (`https://api.meta.ai/v1`) provides sam-3.1 (vision) and muse-spark-1.3 (reasoning). SAM and ERP lookups run independently before comparison.

## Data model
- `inventory`: id UUID PK, sku TEXT NOT NULL, shelf_id TEXT NOT NULL, expected_qty INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1.
- `scans`: id UUID PK, inventory_id UUID FK, media_url TEXT NOT NULL, visible_qty INTEGER, coverage_status TEXT DEFAULT 'unknown', status TEXT DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT NOW().
- `audit_cases`: id UUID PK, scan_id UUID FK, recommendation JSONB, state TEXT DEFAULT 'needs_review', approved_qty INTEGER, created_at TIMESTAMPTZ DEFAULT NOW().
- `audit_events`: id UUID PK, case_id UUID FK, action TEXT NOT NULL, details JSONB, created_at TIMESTAMPTZ DEFAULT NOW().
- Seed fixtures in `fixtures/` (Shelf A-01, SKU BOX-RED, expected 12 — the demo case) with a documented refresh contract.
- **Dev database decision (Slice 2, documented before coding):** local Postgres is unavailable on the dev VM (no server installed, no Docker). When `DATABASE_URL` is set, the server uses real PostgreSQL via `pg` — this is the production/Azure path and the only path that persists. When `DATABASE_URL` is unset, the server uses `pg-mem` (in-memory, pg-compatible) for **DEV ONLY**: same schema, same migrations, data resets on restart. The pg-mem fallback must never be used in production; production requires `DATABASE_URL`. This keeps Slice 2 demoable without a Postgres server while keeping the schema identical.

## API contracts
- `POST /api/scans` — upload media, start analysis → `{ scanId, status }`.
- `GET /api/scans` — list scans, newest first (Slice 2 addition for scan history).
- `GET /api/scans/:id` — progress, visible count, masks/evidence, audit case.
- `GET /api/inventory` — list all inventory records (Slice 2 addition for the inventory view).
- `GET /api/inventory/:shelfId` — expected inventory record.
- `POST /api/audits/:id/approve` — body `{ approvedQty }`; validates version, updates inventory + audit event atomically.
- `POST /api/audits/:id/reject` — body `{ reason }`; records rejection event.
- `GET /api/health` — `{ ok, provider: "meta", llmConfigured, metaConfigured, envWarning }` (same honesty shape as livedocs-meta). **Semantics (QA W2, pinned): `ok` is process health only; consumers MUST check `llmConfigured`/`metaConfigured`, not `ok`, to judge Meta readiness** — with all env vars missing, `ok` is still true and only the configured flags tell the truth.

## Key decisions
- Deterministic counts, LLM explanations: the backend counts, Muse Spark only explains — so a wrong model sentence can never corrupt a number.
- Photo-first, video as enhancement: video tracking identity breaks under full occlusion; if unreliable by Oct 30, photo ships.
- Azure single service over blueprint's Vercel+Render: one URL, $0, proven deploy path (az rest full-list PUT; ARM GET lies; az CLI appsettings fails via proxy 411).
- Impeccable for all UI work (standing rule); Humanizer for submission/README prose.
- No Redis/BullMQ unless the simple worker proves insufficient (rejected: extra infra for a demo).

## Risks
1. **SAM 3.1 access on this key is unverified** — de-risk: Slice 1 probe (one real image → one real segmentation) before any feature code; stop and report on failure.
2. **SAM count accuracy on real photos** — de-risk: validate against manual annotations; 20-scan evaluation with failures published, not hidden.
3. **Video track identity under occlusion** — de-risk: photo-first fallback; occlusion → needs_review.
4. **Meta credit burn** — de-risk: cap scan volume in demo, cache genuinely captured outputs as transparently labeled replay fallback only.
