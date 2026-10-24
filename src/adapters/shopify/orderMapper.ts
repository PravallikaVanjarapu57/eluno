import type { Bill, PostedOrder } from "../../domain/bill.js";
import type { CreditNote } from "../../domain/refund.js";
import type { LedgerOrder } from "../../domain/dayEnd.js";
import { PAYMENT_METHODS, type PaymentMethod } from "../../domain/bill.js";
import { fromShopifyMoney } from "./money.js";
import { toShopifyMoney } from "./money.js";
import type { ShopifyOrder } from "./schemas.js";

// Bill -> Shopify REST order. Every money value becomes a decimal string here and nowhere else.

const GATEWAY = { upi: "razorpay_terminal", card: "razorpay_terminal", cash: "cash" } as const;
const attr = (name: string, value: string) => ({ name, value });

export function toShopifyOrder(bill: Bill) {
  const offerIndex = new Map(bill.appliedOffers.map((o, i) => [o.offerId, i]));
  const noteAttributes = [
    attr("invoice_no", bill.invoiceNo),
    attr("store_code", bill.store.code),
    attr("channel", bill.channel),
    attr("staff_id", bill.staffId),
    attr("payment_method", bill.paymentMethod),
    ...(bill.manualDiscount
      ? [attr("discount_approver_id", bill.manualDiscount.approverId), attr("discount_reason_code", bill.manualDiscount.reasonCode)]
      : []),
  ];

  return {
    order: {
      taxes_included: true,
      currency: "INR",
      location_id: Number(bill.store.locationRef),
      // Frames leave the billing store's stock when the order is created; lenses are not inventory-tracked.
      inventory_behaviour: "decrement_obeying_policy",
      source_name: "eluno-pos",
      processed_at: bill.createdAt,
      customer: { id: Number(bill.customer.id) },
      tags: ["pos", bill.channel].join(","),
      note_attributes: noteAttributes,
      discount_applications: bill.appliedOffers.map((o) => ({
        type: "manual",
        title: o.offerId,
        description: o.name,
        value: toShopifyMoney(o.amountPaise),
        value_type: "fixed_amount",
        allocation_method: "each",
        target_selection: "explicit",
        target_type: "line_item",
      })),
      line_items: bill.lines.map((l) => ({
        variant_id: Number(l.variantId),
        quantity: 1,
        price: toShopifyMoney(l.grossPaise),
        total_discount: toShopifyMoney(l.discountPaise),
        tax_lines: [
          { title: "CGST", rate: l.rateBps / 20000, price: toShopifyMoney(l.cgstPaise) },
          { title: "SGST", rate: l.rateBps / 20000, price: toShopifyMoney(l.sgstPaise) },
        ],
        discount_allocations: l.offerAllocations.map((a) => ({ amount: toShopifyMoney(a.amountPaise), discount_application_index: offerIndex.get(a.offerId)! })),
        properties: [
          attr("line_ref", l.lineId),
          attr("line_type", l.kind),
          attr("hsn", l.hsn),
          attr("pair_ref", l.pairRef),
          attr("taxable_value", toShopifyMoney(l.taxablePaise)),
          ...(l.lens
            ? [
                attr("rx_id", l.lens.rxId),
                attr("rx", JSON.stringify({ od: l.lens.od, os: l.lens.os, pd: l.lens.pd })),
                attr("lens_config", l.lens.configKey),
                attr("lab_tat_days", String(l.lens.labTatDays)),
              ]
            : []),
        ],
      })),
      transactions:
        bill.payment && bill.payment.amountPaise > 0
          ? [
              {
                kind: "sale",
                status: "success",
                gateway: GATEWAY[bill.payment.method],
                amount: toShopifyMoney(bill.payment.amountPaise),
                ...(bill.payment.chargeId ? { authorization: bill.payment.chargeId } : {}),
              },
            ]
          : [],
    },
  };
}

export function noteAttr(order: Pick<ShopifyOrder, "note_attributes">, name: string): string | undefined {
  return order.note_attributes.find((a) => a.name === name)?.value;
}

export function toPostedOrder(o: ShopifyOrder): PostedOrder {
  const lineRefs: Record<string, string> = {};
  for (const li of o.line_items) {
    const ref = li.properties.find((p) => p.name === "line_ref")?.value;
    if (ref) lineRefs[ref] = String(li.id);
  }
  const sale = o.transactions.find((t) => t.kind === "sale" && t.status === "success");
  return { orderRef: String(o.id), orderName: o.name, saleTransactionRef: sale ? String(sale.id) : null, lineRefs };
}

const REFUND_GATEWAY = GATEWAY;

/** Credit note -> Shopify refund: per-line reversal, restock decision per line, refund transaction against the sale. */
export function toShopifyRefund(cn: CreditNote) {
  return {
    refund: {
      note: cn.reasonCode,
      notify: false,
      note_attributes: [
        attr("credit_note_no", cn.creditNoteNo),
        attr("invoice_no", cn.invoiceNo),
        attr("reason_code", cn.reasonCode),
        attr("staff_id", cn.staffId),
      ],
      refund_line_items: cn.lines.map((l) => ({
        line_item_id: Number(l.lineRef),
        quantity: 1,
        restock_type: l.restock.type,
        ...(l.restock.type === "return" ? { location_id: Number(l.restock.locationRef) } : {}),
      })),
      transactions: [
        {
          kind: "refund",
          gateway: REFUND_GATEWAY[cn.refundMethod],
          amount: toShopifyMoney(cn.totals.amountPaise),
          ...(cn.source.saleTransactionRef ? { parent_id: Number(cn.source.saleTransactionRef) } : {}),
        },
      ],
    },
  };
}

export function toRefundCalculate(cn: CreditNote) {
  return {
    refund: {
      refund_line_items: cn.lines.map((l) => ({
        line_item_id: Number(l.lineRef),
        quantity: 1,
        restock_type: l.restock.type,
        ...(l.restock.type === "return" ? { location_id: Number(l.restock.locationRef) } : {}),
      })),
    },
  };
}

const isMethod = (v: string | undefined): v is PaymentMethod => (PAYMENT_METHODS as readonly string[]).includes(v ?? "");

/** Shopify order -> the day-end's view of it (money in paise, our names). */
export function toLedgerOrder(o: ShopifyOrder): LedgerOrder {
  const method = noteAttr(o, "payment_method");
  const taxOf = (title: string) => o.line_items.reduce((a, li) => a + li.tax_lines.filter((t) => t.title === title).reduce((b, t) => b + fromShopifyMoney(t.price), 0), 0);
  return {
    orderRef: String(o.id),
    orderName: o.name,
    invoiceNo: noteAttr(o, "invoice_no") ?? null,
    createdAt: o.created_at,
    channel: noteAttr(o, "channel") ?? null,
    paymentMethod: isMethod(method) ? method : null,
    cancelled: !!o.cancelled_at,
    grossPaise: fromShopifyMoney(o.subtotal_price),
    discountPaise: fromShopifyMoney(o.total_discounts),
    taxPaise: fromShopifyMoney(o.total_tax),
    cgstPaise: taxOf("CGST"),
    sgstPaise: taxOf("SGST"),
    netPaise: fromShopifyMoney(o.total_price),
    discounts: o.discount_applications.map((d) => ({ code: d.title, amountPaise: fromShopifyMoney(d.value) })),
    salePaise: o.transactions.filter((t) => t.kind === "sale" && t.status === "success").reduce((a, t) => a + fromShopifyMoney(t.amount), 0),
    refunds: o.refunds.map((r) => ({
      refundRef: String(r.id),
      creditNoteNo: r.note_attributes.find((a) => a.name === "credit_note_no")?.value ?? null,
      createdAt: r.created_at,
      amountPaise: r.transactions.filter((t) => t.kind === "refund").reduce((a, t) => a + fromShopifyMoney(t.amount), 0),
      taxPaise: r.refund_line_items.reduce((a, l) => a + fromShopifyMoney(l.total_tax), 0),
    })),
  };
}
