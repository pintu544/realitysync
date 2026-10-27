import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.js";

interface SeedRow {
  id: string;
  sku: string;
  shelf_id: string;
  expected_qty: number;
  version: number;
}

// Fixture refresh contract (see fixtures/README.md):
// - Seed rows are keyed by the NATURAL key (shelf_id, sku), not by id.
// - If a row with the same (shelf_id, sku) already exists, it is left
//   completely untouched: refresh never duplicates and never overwrites
//   user-created or user-modified data.
// - Only missing rows are inserted, with their stable fixture UUIDs.
export async function seedFixtures(db: Db): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(join(here, "..", "..", "fixtures", "seed.json"), "utf8");
  const seed = JSON.parse(raw) as { version: number; inventory: SeedRow[] };
  for (const row of seed.inventory) {
    const existing = await db.query(
      "SELECT id FROM inventory WHERE shelf_id = $1 AND sku = $2",
      [row.shelf_id, row.sku],
    );
    if (existing.rows.length > 0) continue;
    await db.query(
      "INSERT INTO inventory (id, sku, shelf_id, expected_qty, version) VALUES ($1, $2, $3, $4, $5)",
      [row.id, row.sku, row.shelf_id, row.expected_qty, row.version],
    );
    console.log(`seeded inventory: shelf ${row.shelf_id} / ${row.sku} (expected ${row.expected_qty})`);
  }
}
