import { Router } from "express";
import { z } from "zod";
import type { Carts } from "../../application/carts.js";
import { mrpTotal, type Cart } from "../../domain/cart.js";
import { describeLens } from "../../domain/catalog.js";
import { CHANNELS } from "../../domain/store.js";
import { DomainError } from "../../domain/errors.js";
import { assertStore, me, requirePermission } from "../middleware/auth.js";

const CreateBody = z
  .object({
    phone: z.string().min(1).optional(),
    customerId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(),
    storeCode: z.string().min(1),
    channel: z.enum(CHANNELS).default("walk_in"),
  })
  .refine((b) => !!b.phone !== !!b.customerId, { message: "send either phone or customerId" });
const SelectRxBody = z.object({ rxId: z.string().min(1).max(40).nullable() });

const variantId = z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).transform(String);
const AddPairBody = z
  .object({ frameVariantId: variantId.optional(), lensVariantId: variantId.optional(), rxId: z.string().min(1).optional() })
  .refine((b) => b.frameVariantId || b.lensVariantId, { message: "frameVariantId or lensVariantId is required" });

// The approver is the signed-in store manager. A client-supplied approverId is only accepted if it is that same person.
const ManagerDiscountBody = z.object({
  approverId: z.string().min(1).optional(),
  reasonCode: z.string().min(1),
  bps: z.number().int(),
});

/** What a till screen needs; prices in paise. */
export function cartView(cart: Cart) {
  return {
    id: cart.id,
    status: cart.status,
    storeCode: cart.storeCode,
    staffId: cart.staffId,
    channel: cart.channel,
    selectedRxId: cart.selectedRxId ?? null,
    customer: { id: cart.customer.id, name: `${cart.customer.firstName} ${cart.customer.lastName}`.trim(), phone: cart.customer.phone, tags: cart.customer.tags },
    pairs: cart.pairs.map((p) => ({
      pairRef: p.pairRef,
      frame: p.frame && { variantId: p.frame.variantId, sku: p.frame.sku, title: p.frame.title, hsn: p.frame.hsn, pricePaise: p.frame.pricePaise },
      lens: p.lens && {
        variantId: p.lens.item.variantId,
        sku: p.lens.item.sku,
        description: describeLens(p.lens.item.config),
        config: p.lens.item.config,
        hsn: p.lens.item.hsn,
        pricePaise: p.lens.item.pricePaise,
        labTatDays: p.lens.item.labTatDays,
        rxId: p.lens.rx.rxId,
      },
    })),
    manualDiscount: cart.manualDiscount && {
      approverId: cart.manualDiscount.approverId,
      reasonCode: cart.manualDiscount.reasonCode,
      bps: cart.manualDiscount.bps,
    },
    mrpTotalPaise: mrpTotal(cart),
    updatedAt: cart.updatedAt,
  };
}

/** Every /:id route: the cart must belong to a store the signed-in user is assigned to. */
export function cartAccess(carts: Carts): (req: import("express").Request, res: import("express").Response, next: import("express").NextFunction, id: string) => void {
  return (req, _res, next, id) => {
    try {
      assertStore(req, carts.get(id).storeCode);
      next();
    } catch (e) {
      next(e);
    }
  };
}

export function cartRoutes(carts: Carts): Router {
  const r = Router();
  r.param("id", cartAccess(carts));

  r.post("/", async (req, res) => {
    const body = CreateBody.parse(req.body);
    assertStore(req, body.storeCode);
    // Who is billing is the signed-in user, never a field of the request.
    res.status(201).json(cartView(await carts.create({ ...body, staffId: me(req).staffId })));
  });

  r.get("/:id", (req, res) => {
    res.json(cartView(carts.get(req.params.id)));
  });

  // PUT /carts/:id/prescription {rxId | null} -> pick the prescription this sale is made to (must be in force), or clear it
  r.put("/:id/prescription", async (req, res) => {
    const { rxId } = SelectRxBody.parse(req.body);
    res.json(cartView(await carts.selectPrescription(String(req.params.id), rxId, me(req).staffId)));
  });

  r.post("/:id/pairs", async (req, res) => {
    const body = AddPairBody.parse(req.body);
    res.status(201).json(cartView(await carts.addPair(req.params.id, body)));
  });

  r.delete("/:id/pairs/:pairRef", (req, res) => {
    res.json(cartView(carts.removePair(req.params.id, req.params.pairRef)));
  });

  // Offers applied automatically; every offer listed with why it did or did not apply.
  r.get("/:id/quote", (req, res) => {
    const q = carts.quote(req.params.id);
    res.json({
      invoiceDate: q.invoiceDate,
      lines: q.lines,
      totals: {
        grossPaise: q.grossPaise,
        discountPaise: q.discountPaise,
        taxablePaise: q.taxablePaise,
        cgstPaise: q.cgstPaise,
        sgstPaise: q.sgstPaise,
        taxPaise: q.taxPaise,
        payablePaise: q.netPaise,
      },
      appliedOffers: q.offers.applied,
      offerEvaluations: q.offers.evaluations,
    });
  });

  r.put("/:id/manager-discount", requirePermission("discount:manager", "Only a store manager can apply a manager discount. Ask a manager to sign in and apply it."), async (req, res) => {
    const body = ManagerDiscountBody.parse(req.body);
    const approver = me(req).staffId;
    if (body.approverId !== undefined && body.approverId !== approver) {
      throw new DomainError("FORBIDDEN", "A manager discount can only be approved by the signed-in manager.", { approverId: body.approverId });
    }
    res.json(cartView(await carts.setManagerDiscount(String(req.params.id), { ...body, approverId: approver })));
  });

  r.delete("/:id/manager-discount", (req, res) => {
    res.json(cartView(carts.clearManagerDiscount(req.params.id)));
  });

  return r;
}

const LensQuery = z.object({ phone: z.string().min(1), rx_id: z.string().optional() });

export function catalogRoutes(carts: Carts): Router {
  const r = Router();

  // GET /catalog/lenses?phone=...&rx_id=...  -> the lens matrix, each option valid/invalid for this Rx
  r.get("/lenses", async (req, res) => {
    const q = LensQuery.parse(req.query);
    const { rx, options } = await carts.lensOptions(q.phone, q.rx_id);
    res.json({
      rxId: rx.rxId,
      options: options.map((o) => ({
        variantId: o.lens.variantId,
        sku: o.lens.sku,
        description: describeLens(o.lens.config),
        ...o.lens.config,
        pricePaise: o.lens.pricePaise,
        labTatDays: o.lens.labTatDays,
        valid: o.valid,
        reasons: o.issues.map((i) => i.message),
      })),
    });
  });

  return r;
}
