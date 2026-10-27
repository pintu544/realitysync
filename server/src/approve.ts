// Human approval + guarded correction (Slice 6, design in DESIGN.md
// before coding). A human reviews an audit case and either APPROVES a
// correction or REJECTS with a reason. The model proposes no quantity:
// approvedQty comes from the request body (the human's verified
// judgment, prefilled with the visible count in the UI but editable).
// Approval is version-guarded (the case records the inventory version
// at creation; a moved version answers 409 stale) and atomic (one
// transaction: inventory update + version bump + case state + audit
// event — a failure rolls everything back, so a half-applied correction
// cannot exist). Rejection changes no inventory but still records its
// reason + event atomically with the state change.
import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { parseAuditCase, type AuditCase } from "./investigate.js";

export class DecisionError extends Error {
  status: number;
  extra?: Record<string, unknown>;
  constructor(status: number, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

interface CaseRow {
  auditCase: AuditCase;
  inventoryId: string;
}

async function loadCase(db: Db, caseId: string): Promise<CaseRow> {
  const { rows } = await db.query(
    `SELECT a.*, s.inventory_id FROM audit_cases a JOIN scans s ON s.id = a.scan_id WHERE a.id = $1`,
    [caseId],
  );
  if (rows.length === 0) throw new DecisionError(404, "audit case not found");
  const auditCase = parseAuditCase(rows[0]);
  if (!auditCase) throw new DecisionError(404, "audit case not found");
  return { auditCase, inventoryId: String(rows[0].inventory_id) };
}

export async function approveCase(
  db: Db,
  caseId: string,
  approvedQty: unknown,
): Promise<{ auditCase: AuditCase; inventory: Record<string, unknown> }> {
  if (typeof approvedQty !== "number" || !Number.isInteger(approvedQty) || approvedQty < 0) {
    throw new DecisionError(400, "approvedQty must be a non-negative integer");
  }
  const { auditCase, inventoryId } = await loadCase(db, caseId);
  if (auditCase.state !== "needs_review") {
    throw new DecisionError(409, "case already decided");
  }
  const invRes = await db.query("SELECT * FROM inventory WHERE id = $1", [inventoryId]);
  if (invRes.rows.length === 0) throw new DecisionError(500, "inventory record missing");
  const inventory = invRes.rows[0];
  const currentVersion = Number(inventory.version);
  // Stale-approval guard (pre-check; the conditional UPDATE inside the
  // transaction closes the check-then-write race).
  if (auditCase.inventory_version === null) {
    throw new DecisionError(
      409,
      "case predates version tracking; re-scan instead of approving against an unknown base",
      { recordedVersion: null, currentVersion },
    );
  }
  if (auditCase.inventory_version !== currentVersion) {
    throw new DecisionError(409, "stale inventory version: the record changed since this case was opened", {
      recordedVersion: auditCase.inventory_version,
      currentVersion,
    });
  }
  const previousQty = Number(inventory.expected_qty);
  let updatedInventory: Record<string, unknown> | null = null;
  await db.withTransaction(async (tx) => {
    const upd = await tx.query(
      "UPDATE inventory SET expected_qty = $1, version = version + 1 WHERE id = $2 AND version = $3 RETURNING *",
      [approvedQty, inventoryId, currentVersion],
    );
    if (upd.rows.length === 0) {
      throw new DecisionError(409, "stale inventory version: the record changed since this case was opened", {
        recordedVersion: auditCase.inventory_version,
        currentVersion,
      });
    }
    updatedInventory = upd.rows[0];
    const caseUpd = await tx.query(
      "UPDATE audit_cases SET state = 'approved', approved_qty = $1 WHERE id = $2 AND state = 'needs_review' RETURNING *",
      [approvedQty, caseId],
    );
    if (caseUpd.rows.length === 0) throw new DecisionError(409, "case already decided");
    await tx.query(
      "INSERT INTO audit_events (id, case_id, action, details) VALUES ($1, $2, $3, $4)",
      [
        randomUUID(),
        caseId,
        "approved",
        JSON.stringify({
          approved_qty: approvedQty,
          previous_qty: previousQty,
          inventory_version_before: currentVersion,
          inventory_version_after: currentVersion + 1,
        }),
      ],
    );
  });
  const refreshed = await db.query("SELECT * FROM audit_cases WHERE id = $1", [caseId]);
  const decided = parseAuditCase(refreshed.rows[0]);
  if (!decided || !updatedInventory) throw new DecisionError(500, "approval did not persist");
  return { auditCase: decided, inventory: updatedInventory };
}

export async function rejectCase(
  db: Db,
  caseId: string,
  reason: unknown,
): Promise<{ auditCase: AuditCase }> {
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new DecisionError(400, "reason must be a non-empty string");
  }
  const { auditCase } = await loadCase(db, caseId);
  if (auditCase.state !== "needs_review") {
    throw new DecisionError(409, "case already decided");
  }
  await db.withTransaction(async (tx) => {
    const upd = await tx.query(
      "UPDATE audit_cases SET state = 'rejected', reject_reason = $1 WHERE id = $2 AND state = 'needs_review' RETURNING *",
      [reason.trim(), caseId],
    );
    if (upd.rows.length === 0) throw new DecisionError(409, "case already decided");
    await tx.query(
      "INSERT INTO audit_events (id, case_id, action, details) VALUES ($1, $2, $3, $4)",
      [randomUUID(), caseId, "rejected", JSON.stringify({ reason: reason.trim() })],
    );
  });
  const refreshed = await db.query("SELECT * FROM audit_cases WHERE id = $1", [caseId]);
  const decided = parseAuditCase(refreshed.rows[0]);
  if (!decided) throw new DecisionError(500, "rejection did not persist");
  return { auditCase: decided };
}
