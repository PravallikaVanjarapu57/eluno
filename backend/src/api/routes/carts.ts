import { Router } from "express";
import { z } from "zod";
import type { Carts } from "../../application/carts.js";
import { mrpTotal, type Cart } from "../../domain/cart.js";
import { describeLens } from "../../domain/catalog.js";
import { CHANNELS } from "../../domain/store.js";

const CreateBody = z.object({
  phone: z.string().min(1),
  storeCode: z.string().min(1),
  staffId: z.string().min(1),
  channel: z.enum(CHANNELS).default("walk_in"),
});

const variantId = z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).transform(String);
const AddPairBody = z
  .object({ frameVariantId: variantId.optional(), lensVariantId: variantId.optional(), rxId: z.string().min(1).optional() })
  .refine((b) => b.frameVariantId || b.lensVariantId, { message: "frameVariantId or lensVariantId is required" });

const ManagerDiscountBody = z.object({
  approverId: z.string().min(1),
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

export function cartRoutes(carts: Carts): Router {
  const r = Router();

  r.post("/", async (req, res) => {
    res.status(201).json(cartView(await carts.create(CreateBody.parse(req.body))));
  });

  r.get("/:id", (req, res) => {
    res.json(cartView(carts.get(req.params.id)));
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

  r.put("/:id/manager-discount", async (req, res) => {
    res.json(cartView(await carts.setManagerDiscount(req.params.id, ManagerDiscountBody.parse(req.body))));
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
