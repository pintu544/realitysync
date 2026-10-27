// Database layer — one schema, two backends (see DESIGN.md "Dev database decision").
// DATABASE_URL set    -> real PostgreSQL via pg (production/Azure path, persists).
// DATABASE_URL unset  -> pg-mem in-memory DB, DEV ONLY (same schema, resets on restart).
// Migrations are idempotent CREATE TABLE IF NOT EXISTS, run on every server start.
import { Pool } from "pg";
import { newDb } from "pg-mem";

export interface Db {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;
  // Runs fn inside one database transaction (BEGIN/COMMIT, ROLLBACK on
  // error). Slice 6 approval needs this: inventory update + version
  // bump + case state + audit event must land together or not at all.
  withTransaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;
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
  // Slice 6: inventory version recorded at case creation (stale-approval
  // guard) + human reject reason on the case itself.
  `ALTER TABLE audit_cases ADD COLUMN IF NOT EXISTS inventory_version INTEGER`,
  `ALTER TABLE audit_cases ADD COLUMN IF NOT EXISTS reject_reason TEXT`,
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
    const baseQuery = (text: string, params?: unknown[]) => pool.query(text, params as any);
    db = {
      query: baseQuery,
      // A dedicated pool client for the whole transaction: Pool.query
      // would grab a different client per statement and break atomicity.
      withTransaction: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const result = await fn({
            query: (t, p) => client.query(t, p as any),
            withTransaction: () => Promise.reject(new Error("nested transactions not supported")),
          });
          await client.query("COMMIT");
          return result;
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
      },
    };
    backend = "postgres";
  } else {
    const mem = newDb();
    const { Client } = mem.adapters.createPg();
    const client = new Client();
    await client.connect();
    const memQuery = (text: string, params?: unknown[]) => client.query(text, params as any);
    db = {
      query: memQuery,
      // pg-mem's pg adapter does NOT roll back DML on ROLLBACK (verified
      // 2026-10-27: a row inserted inside BEGIN survived ROLLBACK), so
      // SQL transactions cannot provide atomicity here. Instead, snapshot
      // with mem.backup() (O(1) restore point) and restore on error —
      // true atomicity on this backend, same guarantee as the Postgres
      // path, with one caveat: the snapshot covers the whole database,
      // so concurrent writers during a transaction would also roll
      // back. Dev-only, single-user demo: acceptable, and documented.
      withTransaction: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => {
        const backup = mem.backup();
        try {
          return await fn({
            query: memQuery,
            withTransaction: () => Promise.reject(new Error("nested transactions not supported")),
          });
        } catch (err) {
          backup.restore();
          throw err;
        }
      },
    };
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
