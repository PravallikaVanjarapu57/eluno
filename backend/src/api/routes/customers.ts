import { Router } from "express";
import { z } from "zod";
import { me, requirePermission } from "../middleware/auth.js";
import type { CreateCustomer } from "../../application/createCustomer.js";
import type { LookupCustomer } from "../../application/lookupCustomer.js";
import type { Customers } from "../../application/customers.js";
import type { Prescriptions } from "../../application/prescriptions.js";
import { flagsOf, fullName, type Customer } from "../../domain/customer.js";

const Query = z.object({
  phone: z.string().min(1).optional(),
  q: z.string().max(80).optional(),
  cursor: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const CreateBody = z.object({
  phone: z.string().trim().min(1, "phone is required"),
  firstName: z.string().trim().min(1, "first name is required").max(60),
  lastName: z.string().trim().max(60).optional(),
  email: z.union([z.literal(""), z.email().max(120)]).optional(),
});

// Phone is accepted only so a form that sends the whole record still works; the service refuses a different number.
const UpdateBody = z.object({
  firstName: z.string().max(200).optional(),
  lastName: z.string().max(200).optional(),
  email: z.string().max(200).nullable().optional(),
  phone: z.string().max(40).optional(),
});

const EyeBody = z.object({
  sph: z.number().optional(),
  cyl: z.number().optional(),
  axis: z.number().nullable().optional(),
  add: z.number().nullable().optional(),
});
const PrescriptionBody = z.object({
  clientRef: z.string().min(8).max(64).optional(),
  testedOn: z.string().max(10),
  validUntil: z.string().max(10).optional(),
  od: EyeBody,
  os: EyeBody,
  pd: z.object({ binocular: z.number().nullable().optional(), monoR: z.number().nullable().optional(), monoL: z.number().nullable().optional() }).optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const id = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const view = (customer: Customer) => ({ customer, name: fullName(customer), flags: flagsOf(customer) });

export function customerRoutes(lookup: LookupCustomer, create: CreateCustomer, customers: Customers, prescriptions: Prescriptions): Router {
  const r = Router();
  const canView = requirePermission("customer:view", "Your role cannot view customers.");

  // GET /customers?phone=9000000005  -> customer, billing-screen flags, prescription to bill against (the till's lookup)
  // GET /customers?q=asha&cursor=&limit= -> one page of customers with a prescription summary each (search by name, email or phone)
  r.get("/", canView, async (req, res) => {
    const query = Query.parse(req.query);
    if (query.phone) return void res.json(await lookup.byPhone(query.phone));
    res.json(await customers.list({ ...(query.q ? { text: query.q } : {}), ...(query.cursor ? { cursor: query.cursor } : {}), ...(query.limit ? { limit: query.limit } : {}) }));
  });

  // POST /customers {phone, firstName, lastName?, email?} -> 201, the same shape as the lookup (ready to bill)
  r.post("/", requirePermission("customer:create", "Your role cannot create customers."), async (req, res) => {
    const body = CreateBody.parse(req.body);
    res.status(201).json(await create.create(body, me(req).staffId));
  });

  r.param("id", (_req, _res, next, value) => {
    const ok = id.safeParse(value).success;
    next(ok ? undefined : Object.assign(new Error("bad id"), { notFound: true }));
  });

  r.get("/:id", canView, async (req, res) => {
    res.json(view(await customers.get(String(req.params.id))));
  });

  // PATCH /customers/:id {firstName?, lastName?, email?}  -> contact details only; prescriptions are untouched
  r.patch("/:id", requirePermission("customer:update", "Your role cannot edit customers."), async (req, res) => {
    const body = UpdateBody.parse(req.body);
    res.json(view(await customers.update(String(req.params.id), body, me(req).staffId)));
  });

  // GET /customers/:id/bills -> their recent bills at your stores
  r.get("/:id/bills", canView, async (req, res) => {
    res.json({ bills: await customers.bills(String(req.params.id), me(req).storeCodes) });
  });

  // GET /customers/:id/prescriptions -> newest first, each with status valid | expired | future_dated
  r.get("/:id/prescriptions", canView, async (req, res) => {
    res.json({ prescriptions: await prescriptions.list(String(req.params.id)) });
  });

  // GET /customers/:id/prescriptions/eligible -> what a sale can pick from: all of them, `eligible` marks the usable ones
  r.get("/:id/prescriptions/eligible", canView, async (req, res) => {
    res.json({ prescriptions: await prescriptions.eligibleForSale(String(req.params.id)) });
  });

  r.get("/:id/prescriptions/:rxId", canView, async (req, res) => {
    res.json(await prescriptions.get(String(req.params.id), String(req.params.rxId)));
  });

  // POST /customers/:id/prescriptions -> 201. Always a new record; an older prescription is never overwritten.
  r.post("/:id/prescriptions", requirePermission("prescription:create", "Your role cannot add prescriptions."), async (req, res) => {
    const { clientRef, ...input } = PrescriptionBody.parse(req.body);
    res.status(201).json(await prescriptions.create(String(req.params.id), input, me(req).staffId, clientRef));
  });

  return r;
}
