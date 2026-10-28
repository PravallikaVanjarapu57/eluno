import { Router } from "express";
import { z } from "zod";
import type { LookupCustomer } from "../../application/lookupCustomer.js";

const Query = z.object({ phone: z.string().min(1, "phone is required") });

export function customerRoutes(lookup: LookupCustomer): Router {
  const r = Router();

  // GET /customers?phone=9000000005  -> customer, billing-screen flags, prescription to bill against
  r.get("/", async (req, res) => {
    const { phone } = Query.parse(req.query);
    res.json(await lookup.byPhone(phone));
  });

  return r;
}
