import { Router } from "express";
import { z } from "zod";
import type { Reference } from "../../application/reference.js";
import { assertStore, me } from "../middleware/auth.js";

const FramesQuery = z.object({ store: z.string().min(1, "store is required") });

export function referenceRoutes(ref: Reference): Router {
  const r = Router();

  // GET /stores -> active billing stores
  r.get("/stores", async (req, res) => {
    const mine = me(req).storeCodes;
    res.json((await ref.stores()).filter((s) => mine.includes(s.code)).map((s) => ({ code: s.code, name: s.name, invoicePrefix: s.invoicePrefix })));
  });

  // GET /stores/:code/staff -> roster with role and discount-override permission
  r.get("/stores/:code/staff", async (req, res) => {
    assertStore(req, req.params.code);
    res.json((await ref.staff(req.params.code)).map((s) => ({ staffId: s.staffId, name: s.name, role: s.role, canOverrideDiscount: s.canOverrideDiscount })));
  });

  // GET /catalog/frames?store=HSR -> sellable frames with stock at that store
  r.get("/catalog/frames", async (req, res) => {
    const { store } = FramesQuery.parse(req.query);
    assertStore(req, store);
    res.json(
      (await ref.frames(store)).map((f) => ({
        variantId: f.variantId, sku: f.sku, title: f.title, category: f.category, rxAble: f.rxAble, pricePaise: f.pricePaise, hsn: f.hsn, available: f.available,
      })),
    );
  });

  // GET /config/reason-codes -> discount and refund reason codes staff can pick from
  r.get("/config/reason-codes", (_req, res) => {
    res.json(ref.reasonCodes());
  });

  return r;
}
