import { Router } from "express";
import { z } from "zod";
import type { Checkout } from "../../application/checkout.js";
import { PAYMENT_METHODS, type Bill } from "../../domain/bill.js";
import type { Carts } from "../../application/carts.js";
import { assertStore, me } from "../middleware/auth.js";
import { cartAccess } from "./carts.js";

const CheckoutBody = z.object({ paymentMethod: z.enum(PAYMENT_METHODS) });
const CancelBody = z.object({ reason: z.string().min(3) });

const NEXT_STEP: Record<Bill["status"], string> = {
  POSTED: "Done. Print the invoice.",
  CHARGED: "Paid. Posting to Shopify.",
  CHARGED_NOT_POSTED: "Paid; Shopify has not confirmed yet. The customer can leave; the till will keep retrying. Print the invoice.",
  NUMBERED: "Payment not confirmed. Check the terminal, then resume (safe: it will not charge twice) or cancel.",
  CANCELLED: "Cancelled. The invoice number stays in the series as cancelled.",
};

export function billView(b: Bill) {
  return {
    invoiceNo: b.invoiceNo,
    status: b.status,
    nextStep: NEXT_STEP[b.status],
    store: b.store.code,
    customer: b.customer,
    channel: b.channel,
    invoiceDate: b.invoiceDate,
    lines: b.lines.map((l) => ({
      lineId: l.lineId, sku: l.sku, title: l.title, hsn: l.hsn, grossPaise: l.grossPaise, discountPaise: l.discountPaise,
      taxablePaise: l.taxablePaise, rateBps: l.rateBps, cgstPaise: l.cgstPaise, sgstPaise: l.sgstPaise, totalPaise: l.netPaise,
      ...(l.lens ? { rxId: l.lens.rxId, lensConfig: l.lens.configKey } : {}),
    })),
    appliedOffers: b.appliedOffers,
    manualDiscount: b.manualDiscount && { approverId: b.manualDiscount.approverId, reasonCode: b.manualDiscount.reasonCode, bps: b.manualDiscount.bps },
    totals: b.totals,
    payment: b.payment,
    shopify: b.posted && { orderId: b.posted.orderRef, orderName: b.posted.orderName },
    lastError: b.lastError,
    cancelReason: b.cancelReason,
  };
}

const statusCode = (b: Bill) => (b.status === "POSTED" ? 201 : b.status === "CANCELLED" ? 402 : 202);

export function checkoutRoute(checkout: Checkout, carts: Carts): Router {
  const r = Router();
  r.param("id", cartAccess(carts));
  // POST /carts/:id/checkout {paymentMethod}
  r.post("/:id/checkout", async (req, res) => {
    const { paymentMethod } = CheckoutBody.parse(req.body);
    const bill = await checkout.checkout(req.params.id, paymentMethod);
    res.status(statusCode(bill)).json(billView(bill));
  });
  // GET /carts/:id/bill -> the cart's live bill, or 404 BILL_NOT_FOUND when checkout never numbered one
  r.get("/:id/bill", (req, res) => {
    res.json(billView(checkout.forCart(req.params.id)));
  });
  return r;
}

const ListQuery = z.object({ store: z.string().min(1), limit: z.coerce.number().int().min(1).max(100).default(25) });

export function billRoutes(checkout: Checkout): Router {
  const r = Router();
  // Every /:invoiceNo route: the bill must belong to a store the signed-in user is assigned to.
  r.param("invoiceNo", (req, _res, next, invoiceNo) => {
    try {
      assertStore(req, checkout.get(invoiceNo).store.code);
      next();
    } catch (e) {
      next(e);
    }
  });
  // GET /bills?store=HSR&limit=25 -> recent bills for the store, newest first
  r.get("/", (req, res) => {
    const q = ListQuery.parse(req.query);
    assertStore(req, q.store);
    res.json(
      checkout.recent(q.store, q.limit).map((b) => ({
        invoiceNo: b.invoiceNo,
        status: b.status,
        customerName: b.customer.name,
        payablePaise: b.totals.payablePaise,
        paymentMethod: b.paymentMethod,
        createdAt: b.createdAt,
      })),
    );
  });
  // Invoice numbers contain slashes (ELU/HSR/FY26/00001): clients URL-encode them.
  r.get("/:invoiceNo", (req, res) => {
    res.json(billView(checkout.get(req.params.invoiceNo)));
  });
  r.post("/:invoiceNo/resume", async (req, res) => {
    const bill = await checkout.resume(req.params.invoiceNo);
    res.status(statusCode(bill) === 201 ? 200 : statusCode(bill)).json(billView(bill));
  });
  r.post("/:invoiceNo/cancel", (req, res) => {
    const { reason } = CancelBody.parse(req.body);
    res.json(billView(checkout.cancel(req.params.invoiceNo, me(req).staffId, reason)));
  });
  return r;
}
