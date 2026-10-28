import { Router } from "express";
import { z } from "zod";
import { me, requirePermission } from "../middleware/auth.js";
import type { CreateCustomer } from "../../application/createCustomer.js";
import type { LookupCustomer } from "../../application/lookupCustomer.js";

const Query = z.object({ phone: z.string().min(1, "phone is required") });

const CreateBody = z.object({
  phone: z.string().trim().min(1, "phone is required"),
  firstName: z.string().trim().min(1, "first name is required").max(60),
  lastName: z.string().trim().max(60).optional(),
  email: z.union([z.literal(""), z.email().max(120)]).optional(),
});

export function customerRoutes(lookup: LookupCustomer, create: CreateCustomer): Router {
  const r = Router();

  // GET /customers?phone=9000000005  -> customer, billing-screen flags, prescription to bill against
  r.get("/", async (req, res) => {
    const { phone } = Query.parse(req.query);
    res.json(await lookup.byPhone(phone));
  });

  // POST /customers {phone, firstName, lastName?, email?} -> 201, the same shape as the lookup (ready to bill)
  r.post("/", requirePermission("customer:create", "Your role cannot create customers."), async (req, res) => {
    const body = CreateBody.parse(req.body);
    res.status(201).json(await create.create(body, me(req).staffId));
  });

  return r;
}
