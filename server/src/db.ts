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
];

let db: Db | null = null;
let backend = "";

export function dbBackend(): string {
  return backend;
}

export async function initDb(): Promise<Db> {
  if (db) return db;
  const url = process.env.DATABASE_URL ?? "";
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
  console.log(`database backend: ${backend}`);
  return db;
}
