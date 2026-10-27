# fixtures/ — versioned seed data

## Contract (refresh never duplicates, never overwrites)
- `seed.json` is versioned (`version` field). Bump it when the seed changes.
- Seed rows carry STABLE fixture UUIDs, but they are keyed on refresh by
  the natural key `(shelf_id, sku)` — not by id.
- On every server start, the seeder inserts only rows whose
  `(shelf_id, sku)` does not already exist. Existing rows are left
  completely untouched: a refresh never duplicates a row and never
  overwrites user-created or user-modified data (e.g. an approved
  correction that changed `expected_qty` survives a restart).
- To change demo data, edit `seed.json` AND bump `version`. To reset a
  dev database, restart the server (pg-mem resets) or drop the tables
  on real Postgres — there is no destructive refresh command.

## Current seed (v1)
- Shelf **A-01**, SKU **BOX-RED**, expected quantity **12** — the demo
  case from the blueprint (ERP 12 vs visible 9, difference −3).
