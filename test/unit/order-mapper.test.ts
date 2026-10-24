import { describe, expect, it } from "vitest";
import { buildBill } from "../../src/domain/bill.js";
import { quoteCart } from "../../src/domain/pricing.js";
import { TaxTable } from "../../src/domain/tax.js";
import { loadPosConfig } from "../../src/config/load.js";
import { toShopifyOrder } from "../../src/adapters/shopify/orderMapper.js";
import { fromShopifyMoney } from "../../src/adapters/shopify/money.js";
import { cart, customer, eye, frame, lens, rx } from "../support/fixtures.js";

const cfg = loadPosConfig("config");
const c = cart({
  channel: "whatsapp_booked",
  customer: customer({ id: "80001005", tags: ["campaign:progressive_oct26", "priority"] }),
  pairs: [{ pairRef: "1", frame: frame(), lens: { item: lens("progressive", 1.6, "blue_cut", { variantId: "91000083", pricePaise: 949900, labTatDays: 7 }), rx: rx({ rxId: "RX5007", customerId: "80001005", od: eye(-3.25, 0, 2.5), os: eye(-3.5, 0, 2.5) }) } }],
});
const bill = {
  ...buildBill({
    invoiceNo: "ELU/HSR/FY26/00003", cart: c, quote: quoteCart(c, cfg.offers, new TaxTable(cfg.taxRates), "2026-10-23"),
    store: { code: "HSR", name: "Eluno HSR Layout", locationRef: "70000002", invoicePrefix: "ELU/HSR/FY26/", stateCode: "29", active: true },
    paymentMethod: "upi", now: "2026-10-23T06:30:00.000Z",
  }),
  payment: { method: "upi" as const, amountPaise: 1869700, chargeId: "chg_1", at: "2026-10-23T06:30:01.000Z" },
};
const { order } = toShopifyOrder(bill);
const props = (i: number) => Object.fromEntries(order.line_items[i]!.properties.map((p) => [p.name, p.value]));

describe("toShopifyOrder", () => {
  it("is shaped the way Shopify (and finance) expect", () => {
    expect(order).toMatchObject({ taxes_included: true, location_id: 70000002, inventory_behaviour: "decrement_obeying_policy", source_name: "eluno-pos", customer: { id: 80001005 }, tags: "pos,whatsapp_booked" });
    expect(order.note_attributes).toEqual([
      { name: "invoice_no", value: "ELU/HSR/FY26/00003" },
      { name: "store_code", value: "HSR" },
      { name: "channel", value: "whatsapp_booked" },
      { name: "staff_id", value: "S105" },
      { name: "payment_method", value: "upi" },
    ]);
    expect(order.transactions).toEqual([{ kind: "sale", status: "success", gateway: "razorpay_terminal", amount: "18697.00", authorization: "chg_1" }]);
  });

  it("money is decimal strings, tax per line, and each line reconciles", () => {
    expect(order.line_items.map((l) => [l.price, l.total_discount, l.tax_lines])).toEqual([
      ["10998.00", "451.27", [{ title: "CGST", rate: 0.09, price: "804.41" }, { title: "SGST", rate: 0.09, price: "804.41" }]],
      ["9499.00", "1348.73", [{ title: "CGST", rate: 0.025, price: "194.06" }, { title: "SGST", rate: 0.025, price: "194.05" }]],
    ]);
    for (const li of order.line_items) {
      const net = fromShopifyMoney(li.price) - fromShopifyMoney(li.total_discount);
      expect(li.discount_allocations.reduce((a, x) => a + fromShopifyMoney(x.amount), 0)).toBe(fromShopifyMoney(li.total_discount));
      expect(fromShopifyMoney(props(order.line_items.indexOf(li)).taxable_value!) + li.tax_lines.reduce((a, t) => a + fromShopifyMoney(t.price), 0)).toBe(net);
    }
  });

  it("one discount application per offer, referenced by index from the lines", () => {
    expect(order.discount_applications.map((d) => [d.title, d.value])).toEqual([["FREE_BLUECUT_PGX", "1000.00"], ["PRIORITY500", "500.00"], ["BUNDLE300", "300.00"]]);
    expect(order.line_items[1]!.discount_allocations).toEqual([
      { amount: "1000.00", discount_application_index: 0 },
      { amount: "217.96", discount_application_index: 1 },
      { amount: "130.77", discount_application_index: 2 },
    ]);
  });

  it("the prescription travels on the lens line", () => {
    expect(props(1)).toMatchObject({ line_ref: "1:lens", line_type: "lens", hsn: "90015000", pair_ref: "1", rx_id: "RX5007", lens_config: "progressive/1.6/blue_cut", lab_tat_days: "7" });
    expect(JSON.parse(props(1).rx!)).toEqual({ od: { sph: -3.25, cyl: 0, axis: null, add: 2.5 }, os: { sph: -3.5, cyl: 0, axis: null, add: 2.5 }, pd: 62 });
    expect(props(0)).toEqual({ line_ref: "1:frame", line_type: "frame", hsn: "90031900", pair_ref: "1", taxable_value: "8937.91" });
  });

  it("a manager discount carries the approver and reason code; cash has no authorization", () => {
    const manual = { offerId: "MANAGER_OVERRIDE", bps: 1000, approverId: "S108", approverRole: "store_manager" as const, approverCanOverride: true, reasonCode: "WALKOUT_SAVE", requestedBy: "S105" };
    const o = toShopifyOrder({ ...bill, manualDiscount: manual, payment: { method: "cash", amountPaise: 1869700, chargeId: null, at: "x" } }).order;
    expect(o.note_attributes).toContainEqual({ name: "discount_approver_id", value: "S108" });
    expect(o.note_attributes).toContainEqual({ name: "discount_reason_code", value: "WALKOUT_SAVE" });
    expect(o.transactions).toEqual([{ kind: "sale", status: "success", gateway: "cash", amount: "18697.00" }]);
  });
});
