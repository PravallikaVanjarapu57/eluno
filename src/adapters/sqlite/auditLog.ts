import type { AuditEvent, AuditLog } from "../../ports/index.js";
import type { Db } from "./db.js";

export class SqliteAuditLog implements AuditLog {
  constructor(private readonly db: Db) {}

  record(e: AuditEvent): void {
    this.db
      .prepare(
        `INSERT INTO audit_events (at, staff_id, action, ref, reason_code, approver_id, payload_json)
         VALUES (@at, @staffId, @action, @ref, @reasonCode, @approverId, @payload)`,
      )
      .run({ at: e.at, staffId: e.staffId, action: e.action, ref: e.ref, reasonCode: e.reasonCode ?? null, approverId: e.approverId ?? null, payload: JSON.stringify(e.payload ?? {}) });
  }

  forRef(ref: string): AuditEvent[] {
    const rows = this.db.prepare("SELECT * FROM audit_events WHERE ref = ? ORDER BY id").all(ref) as Record<string, string | null>[];
    return rows.map((r) => ({
      at: r.at!, staffId: r.staff_id!, action: r.action!, ref: r.ref!,
      ...(r.reason_code && { reasonCode: r.reason_code }), ...(r.approver_id && { approverId: r.approver_id }),
      payload: JSON.parse(r.payload_json ?? "{}"),
    }));
  }
}
