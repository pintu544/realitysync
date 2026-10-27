// Database layer — one schema, two backends (see DESIGN.md "Dev database decision").
// DATABASE_URL set    -> real PostgreSQL via pg (production/Azure path, persists).
// DATABASE_URL unset  -> pg-mem in-memory DB, DEV ONLY (same schema, resets on restart).
// Migrations are idempotent CREATE TABLE IF NOT EXISTS, run on every server start.
import { Pool } from "pg";
import { newDb } from "pg-mem";

export interface Db {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS inventory (
    id UUID PRIMARY KEY,
    sku TEXT NOT NULL,
    shelf_id TEXT NOT NULL,
    expected_qty INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS scans (
    id UUID PRIMARY KEY,
    inventory_id UUID REFERENCES inventory(id),
    media_url TEXT NOT NULL,
    visible_qty INTEGER,
    coverage_status TEXT DEFAULT 'unknown',
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS audit_cases (
    id UUID PRIMARY KEY,
    scan_id UUID REFERENCES scans(id),
    recommendation JSONB,
    state TEXT DEFAULT 'needs_review',
    approved_qty INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS audit_events (
    id UUID PRIMARY KEY,
    case_id UUID REFERENCES audit_cases(id),
    action TEXT NOT NULL,
    details JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS scan_detections (
    scan_id UUID PRIMARY KEY REFERENCES scans(id),
    boxes JSONB,
    mask_count INTEGER,
    latency_ms INTEGER,
    error TEXT,
    analyzed_at TIMESTAMPTZ DEFAULT NOW(),
    raw_box_count INTEGER
  )`,
  `ALTER TABLE scan_detections ADD COLUMN IF NOT EXISTS raw_box_count INTEGER`,
  `ALTER TABLE scan_detections ADD COLUMN IF NOT EXISTS video_stats JSONB`,
];

let db: Db | null = null;
let backend = "";

export function dbBackend(): string {
  return backend;
}

export async function initDb(): Promise<Db> {
  if (db) return db;
  const url = process.env.DATABASE_URL ?? "";
  if (!url && process.env.NODE_ENV === "production") {
    // W1: never silently run the in-memory dev DB in production — a missing
    // DATABASE_URL is a deployment misconfiguration, not a fallback case.
    throw new Error("DATABASE_URL must be set when NODE_ENV=production");
  }
  if (url) {
    const pool = new Pool({ connectionString: url });
    db = { query: (text, params) => pool.query(text, params as any) };
    backend = "postgres";
  } else {
    const mem = newDb();
    const { Client } = mem.adapters.createPg();
    const client = new Client();
    await client.connect();
    db = { query: (text, params) => client.query(text, params as any) };
    backend = "pg-mem (dev only)";
  }
  for (const sql of MIGRATIONS) {
    await db.query(sql);
  }
  // One case per scan, enforced in the database as well as in code
  // (investigate.ts re-checks before inserting). Tolerant on purpose: a
  // pre-existing database with duplicate cases must not kill startup —
  // the code-level guard still mitigates there.
  try {
    await db.query(
      "CREATE UNIQUE INDEX IF NOT EXISTS audit_cases_scan_id_unique ON audit_cases(scan_id)",
    );
  } catch {
    console.log("audit_cases unique index skipped (pre-existing duplicates?)");
  }
  console.log(`database backend: ${backend}`);
  return db;
}
