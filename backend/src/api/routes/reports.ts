import { Router } from "express";
import { z } from "zod";
import type { DayEnd } from "../../application/dayEnd.js";
import { dayEndToCsv } from "../../domain/dayEndCsv.js";
import type { AuditLog, Clock } from "../../ports/index.js";
import { assertStore, me, requirePermission } from "../middleware/auth.js";

const Query = z.object({
  store: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD").optional(),
});

export function reportRoutes(dayEnd: DayEnd, audit: AuditLog, clock: Clock): Router {
  const r = Router();

  // GET /reports/day-end?store=JN&date=2026-10-06   (date defaults to today, IST). Store managers, for their own store.
  r.get("/day-end", requirePermission("report:view", "Day-end reports are for store managers."), async (req, res) => {
    const q = Query.parse(req.query);
    assertStore(req, q.store);
    res.json(await dayEnd.report(q.store, q.date));
  });

  // GET /reports/day-end.csv?store=JN&date=2026-10-06 -> the same report as a download. Store managers only, enforced here.
  r.get("/day-end.csv", requirePermission("report:download", "Only store managers can download reports."), async (req, res) => {
    const q = Query.parse(req.query);
    assertStore(req, q.store);
    const report = await dayEnd.report(q.store, q.date);
    audit.record({ at: clock.now().toISOString(), staffId: me(req).staffId, action: "report.downloaded", ref: `day-end:${report.storeCode}:${report.date}`, payload: { format: "csv" } });
    res
      .status(200)
      .type("text/csv; charset=utf-8")
      .set({ "Content-Disposition": `attachment; filename="eluno-day-end-${report.storeCode}-${report.date}.csv"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" })
      .send(dayEndToCsv(report));
  });

  return r;
}
