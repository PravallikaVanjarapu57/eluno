// The Must flow end to end, narrated, against a fresh mock. Used for the Loom.
//   npm run demo            (mock without random failures)
//   npm run demo -- --flaky (mock returns 429s and terminal 503s like production)
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { compose } from "../src/compose.js";
import { loadEnv } from "../src/config/env.js";
import { createApp } from "../src/api/app.js";
import { formatInr } from "../src/domain/money.js";
import { istDate } from "../src/domain/dayEnd.js";

const flaky = process.argv.includes("--flaky");
const MOCK_PORT = 8797;
const MOCK = `http://localhost:${MOCK_PORT}`;
const SHOPIFY = `${MOCK}/admin/api/2026-10`;
const TODAY = istDate(new Date().toISOString());

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const step = (n: number, title: string) => console.log(`\n${bold(`${n}. ${title}`)}`);
const rs = (p: number) => formatInr(p);
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
const lpad = (s: string, n: number) => s.padStart(n);

// ---------------------------------------------------------------- start a clean mock and the API in-process
const mockArgs = ["starter-kit/mock-apis/mock_server.py", "--port", String(MOCK_PORT), ...(flaky ? [] : ["--no-flake"])];
const pythonBin = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const mock = spawn(pythonBin, mockArgs, { stdio: "ignore" });
process.on("exit", () => mock.kill());
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`${MOCK}/health`)).ok) break;
  } catch {
    if (i > 50) throw new Error("mock did not start");
    await new Promise((r) => setTimeout(r, 100));
  }
}
const quietLog = console.log;
const deps = compose(loadEnv({ SHOPIFY_BASE_URL: MOCK, DB_PATH: ":memory:", TILL_TODAY: TODAY }));
const server = createApp(deps).listen(0);
const API = `http://localhost:${(server.address() as AddressInfo).port}`;

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: (await res.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
const shopify = async (path: string) => (await fetch(`${SHOPIFY}/${path}`)).json() as Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const stock = async () => (await shopify("inventory_levels.json?inventory_item_ids=92000003&location_ids=70000002")).inventory_levels[0].available as number;

console.log(bold(`Eluno till: the Must flow at HSR Layout on ${TODAY}`) + dim(flaky ? "  (mock: random 429s and terminal 503s ON)" : "  (mock: no random failures)"));
// Upstream chatter from the adapters: retries only matter in flaky mode; the series start is worth showing.
console.log = (...a: unknown[]) => {
  const m = typeof a[0] === "string" ? a[0] : "";
  if (/call limit/.test(m)) return;
  if (/retry|post attempt/.test(m)) return void (flaky && quietLog(dim(`   · ${m}`)));
  if (/invoice series/.test(m)) return void quietLog(dim(`   · ${m}`));
  quietLog(...a);
};

// ---------------------------------------------------------------- 1. lookup
step(1, "Customer by phone (Shopify) + prescription in force (store tool)");
const look = (await api("GET", "/customers?phone=90000%2000005")).body;
console.log(`   ${look.customer.firstName} ${look.customer.lastName}  ${look.customer.phone}  ${look.flags.priority ? green("PRIORITY") : ""} ${look.flags.campaigns.map((c: string) => `campaign:${c}`).join(" ")}`);
const rx = look.prescription.rx;
const eye = (e: { sph: number; cyl: number; add: number | null }) => `SPH ${e.sph.toFixed(2)} CYL ${e.cyl.toFixed(2)} ADD ${e.add?.toFixed(2) ?? "-"}`;
console.log(`   ${rx.rxId} (${rx.source}, valid until ${rx.validUntil})  OD ${eye(rx.od)} | OS ${eye(rx.os)}`);

// ---------------------------------------------------------------- 2. lens validation
step(2, "Lens validated against the prescription");
const other = (await api("POST", "/carts", { phone: "9000000017", storeCode: "HSR", staffId: "S105" })).body;
const blocked = await api("POST", `/carts/${other.id}/pairs`, { lensVariantId: "91000045" });
console.log(`   Another customer (RX5026, SPH -5.25) asks for single vision 1.56:`);
console.log(`   ${red(`✗ ${blocked.status} ${blocked.body.code}`)}  ${blocked.body.message}`);
const noAdd = (await api("POST", "/carts", { phone: "9000000011", storeCode: "HSR", staffId: "S105" })).body;
const noAddRes = await api("POST", `/carts/${noAdd.id}/pairs`, { lensVariantId: "91000081" });
console.log(`   A progressive for a prescription with no ADD (RX5016):`);
console.log(`   ${red(`✗ ${noAddRes.status} ${noAddRes.body.code}`)}  ${noAddRes.body.details.issues[0].message}`);

// ---------------------------------------------------------------- 3. cart
step(3, "Cart: frame + progressive 1.60 blue cut for Karthik");
const cart = (await api("POST", "/carts", { phone: "9000000005", storeCode: "HSR", staffId: "S105", channel: "whatsapp_booked" })).body;
const added = (await api("POST", `/carts/${cart.id}/pairs`, { frameVariantId: "91000003", lensVariantId: "91000083" })).body;
for (const p of added.pairs) {
  console.log(`   pair ${p.pairRef}: ${p.frame.sku} ${p.frame.title}  ${rs(p.frame.pricePaise)}`);
  console.log(`           ${p.lens.sku} ${p.lens.description} on ${p.lens.rxId}  ${rs(p.lens.pricePaise)}  (lab ${p.lens.labTatDays} days)`);
}

// ---------------------------------------------------------------- 4. offers + tax
step(4, "Offers by their rules, then GST per line by HSN");
const q = (await api("GET", `/carts/${cart.id}/quote`)).body;
for (const e of q.offerEvaluations) console.log(`   ${e.applied ? green("✓") : dim("·")} ${pad(e.offerId, 18)} ${e.applied ? rs(e.amountPaise) : dim(e.why)}`);
console.log(`\n   ${pad("line", 8)} ${pad("HSN", 9)} ${lpad("MRP", 11)} ${lpad("discount", 10)} ${lpad("taxable", 11)} ${lpad("CGST", 13)} ${lpad("SGST", 13)} ${lpad("total", 11)}`);
for (const l of q.lines) {
  const r = `${l.rateBps / 200}%`;
  console.log(`   ${pad(l.lineId, 8)} ${pad(l.hsn, 9)} ${lpad(rs(l.grossPaise), 11)} ${lpad(rs(l.discountPaise), 10)} ${lpad(rs(l.taxablePaise), 11)} ${lpad(`${r} ${rs(l.cgstPaise)}`, 13)} ${lpad(`${r} ${rs(l.sgstPaise)}`, 13)} ${lpad(rs(l.netPaise), 11)}`);
}
const t = q.totals;
console.log(`   ${pad("TOTAL", 18)} ${lpad(rs(t.grossPaise), 11)} ${lpad(rs(t.discountPaise), 10)} ${lpad(rs(t.taxablePaise), 11)} ${lpad(rs(t.cgstPaise), 13)} ${lpad(rs(t.sgstPaise), 13)} ${lpad(bold(rs(t.payablePaise)), 11)}`);

// ---------------------------------------------------------------- 5. charge + Shopify order
step(5, "Charge the terminal, then create the order in Shopify");
const stockBefore = await stock();
const started = Date.now();
const bill = (await api("POST", `/carts/${cart.id}/checkout`, { paymentMethod: "upi" })).body;
console.log(`   ${green(bill.status)}  invoice ${bold(bill.invoiceNo)}  charge ${bill.payment.chargeId}  Shopify ${bill.shopify.orderName}  ${dim(`(${Date.now() - started} ms)`)}`);
const { order } = await shopify(`orders/${bill.shopify.orderId}.json`);
const attr = (n: string) => order.note_attributes.find((a: { name: string }) => a.name === n)?.value;
console.log(`   Shopify says: ${order.financial_status}, total ${order.total_price}, tax ${order.total_tax}, discounts ${order.total_discounts}, invoice_no ${attr("invoice_no")}, channel ${attr("channel")}`);
const lensProps = Object.fromEntries(order.line_items[1].properties.map((p: { name: string; value: string }) => [p.name, p.value]));
console.log(`   Lens line carries rx_id ${lensProps.rx_id}, lens_config ${lensProps.lens_config}, rx ${dim(lensProps.rx)}`);
console.log(`   Frame stock at HSR: ${stockBefore} → ${await stock()}`);
const again = (await api("POST", `/carts/${cart.id}/checkout`, { paymentMethod: "upi" })).body;
console.log(`   Pressing charge again returns ${again.invoiceNo} ${again.status}: no second charge, no second order.`);

// ---------------------------------------------------------------- 6. refund
step(6, "Full refund through Shopify's refund flow");
const cn = (await api("POST", `/bills/${encodeURIComponent(bill.invoiceNo)}/refund`, { staffId: "S108", reasonCode: "CHANGED_MIND" })).body;
console.log(`   ${green(cn.status)}  credit note ${bold(cn.creditNoteNo)} against ${cn.invoiceNo}, ${rs(cn.totals.amountPaise)} back by ${cn.refundMethod}`);
for (const l of cn.lines) console.log(`   ${pad(l.sku, 8)} tax reversed ${rs(l.cgstPaise + l.sgstPaise)} on ${rs(l.amountPaise)}  restock: ${l.restock}`);
const after = (await shopify(`orders/${bill.shopify.orderId}.json`)).order;
console.log(`   Shopify says: ${after.financial_status}; refund transaction parent_id ${after.refunds[0].transactions[0].parent_id} = sale ${after.transactions[0].id}`);
console.log(`   Frame stock at HSR back to ${await stock()}`);

// ---------------------------------------------------------------- 7. day-end
step(7, "Day-end for HSR, computed from Shopify orders");
const de = (await api("GET", `/reports/day-end?store=HSR&date=${TODAY}`)).body;
console.log(`   bills ${de.sales.bills}  gross ${rs(de.sales.grossPaise)}  discounts ${rs(de.sales.discountPaise)}  taxable ${rs(de.sales.taxablePaise)}  tax ${rs(de.sales.taxPaise)}  net ${rs(de.sales.netSalesPaise)}`);
console.log(`   refunds ${de.refunds.count} (${rs(de.refunds.amountPaise)})  net after refunds ${rs(de.netAfterRefundsPaise)}`);
for (const [m, v] of Object.entries(de.byPaymentMethod) as [string, { salesPaise: number; refundsPaise: number; netPaise: number }][]) {
  console.log(`   ${pad(m, 5)} sales ${rs(v.salesPaise)}  refunds ${rs(v.refundsPaise)}  net ${rs(v.netPaise)}`);
}
console.log(`   reconciliation with the till: ${de.reconciliation.status === "matched" ? green("matched") : red(de.reconciliation.status)}`);

const seed = (await api("GET", "/reports/day-end?store=HSR&date=2026-10-12")).body;
console.log(dim(`   (seed) HSR 2026-10-12: ${seed.sales.bills} bills, ${seed.refunds.count} refund of ${rs(seed.refunds.amountPaise)} for #1007 billed on 10-09`));

console.log(`\n${green("Done.")} ${dim("Mock state is in memory and discarded.")}`);
server.close();
deps.db.close();
mock.kill();
