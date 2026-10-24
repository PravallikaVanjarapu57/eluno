import { buildBill, type Bill } from "../../src/domain/bill.js";
import { quoteCart } from "../../src/domain/pricing.js";
import { TaxTable } from "../../src/domain/tax.js";
import { loadPosConfig } from "../../src/config/load.js";
import type { Store } from "../../src/domain/store.js";
import { cart, customer, eye, frame, lens, rx } from "./fixtures.js";

const cfg = loadPosConfig("config");
export const HSR: Store = { code: "HSR", name: "Eluno HSR Layout", locationRef: "70000002", invoicePrefix: "ELU/HSR/FY26/", stateCode: "29", active: true };

/** Karthik's frame + progressive bill, paid and posted. */
export function postedBill(over: Partial<Bill> = {}): Bill {
  const c = cart({
    customer: customer({ id: "80001005", tags: ["campaign:progressive_oct26", "priority"] }),
    pairs: [{ pairRef: "1", frame: frame(), lens: { item: lens("progressive", 1.6, "blue_cut", { pricePaise: 949900 }), rx: rx({ customerId: "80001005", od: eye(-3.25, 0, 2.5), os: eye(-3.25, 0, 2.5) }) } }],
  });
  const bill = buildBill({ invoiceNo: "ELU/HSR/FY26/00003", cart: c, quote: quoteCart(c, cfg.offers, new TaxTable(cfg.taxRates), "2026-10-23"), store: HSR, paymentMethod: "upi", now: "2026-10-23T06:30:00.000Z" });
  return {
    ...bill,
    status: "POSTED",
    payment: { method: "upi", amountPaise: bill.totals.payablePaise, chargeId: "chg_1", at: "2026-10-23T06:30:01.000Z" },
    posted: { orderRef: "95000100", orderName: "#2000", saleTransactionRef: "97000100", lineRefs: { "1:frame": "96000100", "1:lens": "96000101" } },
    ...over,
  };
}
