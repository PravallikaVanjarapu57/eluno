import { Router } from "express";
import { z } from "zod";
import type { DayEnd } from "../../application/dayEnd.js";

const Query = z.object({
  store: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD").optional(),
});

export function reportRoutes(dayEnd: DayEnd): Router {
  const r = Router();
  // GET /reports/day-end?store=JN&date=2026-10-06   (date defaults to today, IST)
  r.get("/day-end", async (req, res) => {
    const q = Query.parse(req.query);
    res.json(await dayEnd.report(q.store, q.date));
  });
  return r;
}
