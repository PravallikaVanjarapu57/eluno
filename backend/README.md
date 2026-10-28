# Eluno till (v1)

The billing app that replaces Shopify POS in Eluno stores. Shopify stays the system of record: every order,
payment, refund and restock this till makes lands in Shopify through the Admin API. Prescriptions come from
the store tool. The till owns the invoice and credit-note series, offers, tax rates, the audit trail and
day-end reconciliation.

It is an HTTP API (no screen), Node.js + Express + TypeScript, with SQLite for the data the till owns.

## Run it

Needs Node.js 20+ and Python 3.8+ (for the starter-kit mock). From a fresh clone:

```bash
./run.sh            # installs dependencies if needed, starts the mock (:8787) and the API (:3000)
./run.sh --demo     # the whole Must flow, narrated, against a fresh mock (what the Loom shows)
./run.sh --flaky    # same server, but the mock returns 429s and terminal 503s like production
```

Or with npm: `npm ci`, then `npm start` / `npm run demo` / `npm run start:flaky`.
Tests: `npm test` (unit + integration; integration tests start their own mocks). Also `npm run typecheck`, `npm run lint`.

`TILL_TODAY=YYYY-MM-DD` pins the business date (IST) if you want to replay the seed data's days; by default
it is today in IST. The till's database is `data/till.db`; delete it to start over. The mock is in memory
and resets on restart.

### Where the data lives

Shopify is the backend. Customers, products, prices, lens limits, stock, orders, payments and refunds are
read from and written to the Shopify Admin API on every request. The till keeps no copy of them; with Shopify
down, lookups and the day-end return `502`. Prescriptions and staff come from the store tool, and payments
from the terminal. The till's SQLite database holds only what the brief says the till owns: the invoice and
credit-note series, each bill's progress (so a dropped connection can resume it), carts in progress, the cash
till and the audit trail.

### Configuration

| Variable | Default | |
|---|---|---|
| `SHOPIFY_BASE_URL` | `http://localhost:8787` | Shopify Admin host; `https://<shop>.myshopify.com` in production. The starter-kit mock serves it locally. |
| `SHOPIFY_API_VERSION` | `2026-10` | Admin API version in the path (`/admin/api/<version>/…`). |
| `SHOPIFY_ACCESS_TOKEN` | not set | Sent as `X-Shopify-Access-Token`, to Shopify only (never to the store tool or terminal, never logged). The mock ignores it; real Shopify requires it, and the API warns at startup if it is missing for a non-local shop. |
| `SMT_BASE_URL` | `SHOPIFY_BASE_URL` | Store tool (prescriptions, staff). Defaults to the Shopify URL because the mock serves all three on one port. |
| `TERMINAL_BASE_URL` | `SHOPIFY_BASE_URL` | Payment terminal. Same default. |
| `PORT`, `DB_PATH`, `CONFIG_DIR`, `TILL_TODAY` | `3000`, `data/till.db`, `config`, today | |

`npm start` / `./run.sh` always start the mock and point all three at it. Against real systems, set the variables
and run the API alone: `SHOPIFY_BASE_URL=https://eluno.myshopify.com SHOPIFY_ACCESS_TOKEN=shpat_… SMT_BASE_URL=… TERMINAL_BASE_URL=… npm run api`.

## The Must flow over HTTP

```bash
# 1. customer + prescription in force + billing-screen flags (priority, campaign)
curl 'localhost:3000/customers?phone=9000000005'

# 2. lens matrix marked valid/invalid for the Rx; cart with a frame and a validated lens
curl 'localhost:3000/catalog/lenses?phone=9000000005'
CART=$(curl -s -XPOST localhost:3000/carts -H 'content-type: application/json' \
  -d '{"phone":"9000000005","storeCode":"HSR","staffId":"S105","channel":"whatsapp_booked"}' | jq -r .id)
curl -XPOST localhost:3000/carts/$CART/pairs -H 'content-type: application/json' \
  -d '{"frameVariantId":"91000003","lensVariantId":"91000083"}'

# 3 + 4. offers applied by their rules (each offer says why it did or didn't apply) and GST per line
curl localhost:3000/carts/$CART/quote
# optional: manager discount (store manager approver + reason code, max 10%)
curl -XPUT localhost:3000/carts/$CART/manager-discount -H 'content-type: application/json' \
  -d '{"approverId":"S108","reasonCode":"WALKOUT_SAVE","bps":1000}'

# 5. charge the terminal, create the Shopify order
curl -XPOST localhost:3000/carts/$CART/checkout -H 'content-type: application/json' -d '{"paymentMethod":"upi"}'

# 6. full refund (invoice numbers contain slashes: URL-encode them)
curl -XPOST 'localhost:3000/bills/ELU%2FHSR%2FFY26%2F00003/refund' -H 'content-type: application/json' \
  -d '{"staffId":"S108","reasonCode":"CHANGED_MIND"}'

# 7. day-end for a store and date, from Shopify, reconciled against the till
curl 'localhost:3000/reports/day-end?store=HSR&date=2026-10-23'
```

**Postman:** import `postman/eluno-till.postman_collection.json` (and optionally
`postman/eluno-till.local.postman_environment.json`). It has every endpoint in the order of a real bill: each
request saves the ids the next one needs, plus error examples and read-backs from the Shopify mock. Start the server,
then run it in the Collection Runner, or from the terminal:
`npx newman run postman/eluno-till.postman_collection.json` (42 requests, 52 assertions, needs a fresh server).

Other routes: `GET /carts/:id`, `DELETE /carts/:id/pairs/:pairRef`, `DELETE /carts/:id/manager-discount`,
`GET /bills/:invoiceNo`, `POST /bills/:invoiceNo/resume`, `POST /bills/:invoiceNo/cancel`,
`GET /bills/:invoiceNo/refunds`, `GET /credit-notes/:no`, `POST /credit-notes/:no/resume`, `GET /health`.

Errors are `{code, message, details}`; `message` is written for sales staff and says what to do next, e.g.
`LENS_RX_MISMATCH: Right eye (OD) SPH -5.25 is outside the single vision 1.56 standard range (-4.00 to +4.00)… Choose index 1.60, 1.67, 1.74 for single vision.`

## What's built

| Brief | Status |
|---|---|
| Must 1. Customer by phone + latest valid prescription | Done. "Latest valid" = most recent test that is in force today; six seed prescriptions are dated in the future and are skipped with a reason. External Rx and off-grid axes are flagged. |
| Must 2. Cart with frame + lens, validated against the Rx | Done. SPH/CYL per eye within the lens's limits, ADD required and in range for progressive/bifocal, expired Rx blocked, frame stock at the billing store, archived frames and non-Rx sunglasses handled. |
| Must 3. Offers by their rules | Done. Dates, conditions, stackability, caps, best outcome for the customer, manager override with reason code. |
| Must 4. GST per line by HSN | Done. Reconciled to the paisa; reproduces every line of `orders_sample.json`. |
| Must 5. Charge, then create the order in Shopify | Done. Per-store gapless invoice number, Rx on the lens line, tax lines, discounts, sale transaction, stock decremented at the store; idempotent under retries and timeouts. |
| Must 6. Full refund | Done. Credit note series, tax reversed per line, frame restocked at the billing store, lens not restocked, refund transaction against the sale. |
| Must 7. Day-end report | Done. Bill count, gross, taxable, tax, discounts, refunds, payment split, from Shopify, with a reconciliation against the till. |
| Should: sales channel | Partly. Channel is on every cart and order, and the day-end splits by channel. No separate channel report across stores. |
| Should: audit trail | Partly. Every state change, manager discount and refund is recorded (who, what, when, reason code, approver) in `audit_events`. No endpoint to read it yet. |
| Should: cash till, partial refund, printable invoice | Not built. The cash-till tables exist (migration 2); nothing writes them. |
| Stretch | Not attempted. |

**Where I stopped:** after Must and the demo. The next thing I would build is the cash till, because two
stakeholders asked for it (Meena's paid-outs, Vikram's variance over ₹200), and the day-end report already has
the cash-sales figure it needs to reconcile against.

## Architecture

```
src/
  domain/        pure rules, no I/O, no Shopify types: money, tax, prescription, lens, cart, offers, pricing,
                 bill, refund, day-end
  application/   use cases that orchestrate the domain and the ports: lookup, carts, checkout, refunds, day-end
  ports/         the interfaces the application needs (CustomerDirectory, Catalog, OrderSink, PaymentTerminal, …)
  adapters/      shopify/ (the only code that knows Shopify's shapes), smt/, terminal/, sqlite/, http/ (retrying client)
  api/           Express routes and error mapping
  config/        loads and validates config/*.json
  compose.ts     the one place that picks concrete adapters
config/          offers.json, tax_rates.json, reason_codes.json: data, not code
```

An ESLint rule forbids `domain/` and `application/` from importing `adapters/`.

**If Shopify is replaced in 2027:** write a new adapter implementing `CustomerDirectory`, `Catalog`,
`StockLevels`, `StoreDirectory`, `OrderSink` and `SalesLedger`, and change `compose.ts`. The domain's ids are
opaque strings; money is paise; nothing outside `adapters/shopify/` knows about `note_attributes`,
`discount_allocations` or decimal strings. The invoice series, offers, tax and audit trail stay as they are.

## Decisions

**Money.** Integer paise everywhere. `"104.98"` strings exist only in `adapters/shopify/money.ts`, which parses
the string itself rather than going through a float (`"0.29"` → 29, not 28.999…).

**Tax.** Per line, on the amount after discount: `taxable = round_half_up(gross × 10000 / (10000 + rate_bps))`,
`CGST = round_half_up(tax / 2)`, `SGST = tax − CGST`, so `taxable + CGST + SGST = gross` exactly. The rate is
the one in force for that HSN on the invoice date, so a rate change never alters an issued invoice (lenses
were 12% until 2025-09-22 and 5% after; both are tested). A missing rate blocks billing with a message for
finance. A golden test recomputes every line of all 12 sample orders from our own rate table.

**Offers.** (`src/domain/offers/engine.ts`)
- Eligible = active, today within its dates (inclusive), conditions hold, something to discount.
- Non-stackable means "combines with nothing". Candidates are each non-stackable offer alone, and all
  stackable offers together (adding a stackable offer never lowers the total, so no subset can win).
- The customer gets the candidate with the biggest discount; ties go to the lowest `priority` number, then
  fewer offers, then offer id, so the result is deterministic.
- Within a candidate, offers apply in priority order, each on what is left; no line goes below zero.
- Frame/lens offers apply per matching line; "second pair" goes to the cheaper lens and counts only pairs with
  a lens (a frame-only sunglasses sale is not a second pair); pair offers once per frame+lens pair; cart offers
  once. Flat amounts are split across lines in proportion to value, to the paisa (largest remainder).
- Every offer gets a one-line reason. On the seed's bill #1001 the old till applied PGX_CAMPAIGN15 (₹1,424.85);
  the engine finds FREE_BLUECUT_PGX + PRIORITY500 + BUNDLE300 (₹1,800) and says so.
- Manager discount: approver must be a store manager at that store with `can_override_discount`, a reason code
  from `config/reason_codes.json`, at most 10%. It is non-stackable in the data, so it only applies when it beats
  the other offers. Approver and reason code go on the Shopify order and into the audit log.

**Invoice and credit-note numbers.** Gapless per store, held in SQLite. A number is taken in the same
transaction that writes the bill, before the customer is charged, and doubles as the terminal's `order_ref`
and the key for finding the order in Shopify. A declined or abandoned bill is `CANCELLED` and stays in the
series. The first time a store bills, its series continues after the highest number already in Shopify (HSR's
first is 00003; its first credit note is CN/00003 because the seed has CN/00002). Credit notes use the store
prefix + `CN/`.

**Idempotency and retries.** (`src/application/checkout.ts`, `refunds.ts`, `adapters/http/client.ts`)
- A bill moves `NUMBERED → CHARGED → POSTED` (or `CHARGED_NOT_POSTED`, or `CANCELLED`); each step is saved
  before the next external call, so any step can be resumed.
- The HTTP client always retries 429 after `Retry-After` (nothing was written). It retries 5xx/timeouts only
  for requests that are safe to repeat (GETs, terminal charges keyed by `order_ref`). For a Shopify write whose
  outcome is unknown it does not retry; checkout first looks the order up by invoice number and only writes if
  it is not there.
- Terminal outcome unknown: the bill stays `NUMBERED`; resume retries with the same `order_ref`, which cannot
  double-charge. Shopify down after payment: `CHARGED_NOT_POSTED`, the customer can leave, and a recovery
  sweep (at startup and every minute) posts it once. The sweep never charges anyone.
- Pressing "charge" twice returns the same bill: one live bill per cart is a DB constraint, and one in-process
  driver per bill.
- Terminal refunds have no idempotency key, so before paying out the till reads how much the charge has
  already had refunded.

**Refunds.** A credit note copies the invoice's taxable value, CGST and SGST line by line rather than
recomputing them. Before any money moves, Shopify's `refunds/calculate.json` must agree with those amounts.
Money goes back first (terminal, or cash from the drawer), then the Shopify refund: frame `restock_type:
return` at the billing location, lens `no_restock`, refund transaction with `parent_id` = the sale.

**Day-end source of truth.** Shopify, because finance reconciles there. Sales count on the day the order was
created and refunds on the day they were made (so #1007, billed 10-09 and refunded 10-12, shows on 10-12). Dates
are IST calendar days. The till's own ledger is laid alongside: posted-but-missing, paid-not-posted,
amount differs, payment not captured and refund not posted are errors that make the day not reconcile; orders
in Shopify that this till did not bill (the old POS) are listed as information.

**Prescription on the order.** The lens line carries `rx_id`, the prescription itself as JSON (`od`, `os`,
`pd`), `lens_config` and `lab_tat_days`, so the lab and any later remake have it without asking the store tool.

**Upstream data that does not match.** Responses are validated with zod in the adapters. A shape mismatch is
reported as `502 UPSTREAM_BAD_RESPONSE`, not a 400 blaming the caller. HQ's location has no invoice prefix and
is treated as non-billing.

## Tests

232 tests: `npm test`.

- Golden: GST for every line and order in `orders_sample.json`; the sample invoice for #1001.
- Offers: the seed bills (#1001, #1003, #1007, #1010), caps, dates, lens conditions, second pair, ties,
  manager discount, invariants (no line negative, line discounts sum to the total).
- Checkout and refunds with fake ports that write-then-time-out, time out, reject, decline, lose the terminal's
  answer, and race two requests: no double charge, no duplicate order, no duplicate refund, gapless series.
- Integration against the real mock, including a run with random 429s and 503s on: 8 bills and 3 refunds, each
  posted once, numbers consecutive, the day-end reconciles.

## Known gaps

- **Pagination.** Order scans (finding an order by invoice number, the series start, day-end) read one page of
  250. Real stores need `page_info` pagination, or better, Shopify webhooks feeding a local copy.
- **Lookup race.** If Shopify is still processing a timed-out order create when the till looks it up, the
  lookup can miss it and the till writes again. Narrow, but real; a webhook or a short wait before the lookup
  narrows it further.
- **One process.** "One driver per bill" is in-process. Several API processes on one database would need a
  DB-level lock (or one till service per store).
- **Invoice series in a local SQLite file.** Production needs it in a backed-up central store. The financial year
  comes from the store's prefix in Shopify (`FY26`); how it rolls over on 1 April is for finance to confirm.
- **No auth.** Staff id is taken from the request and checked against the store roster, nothing more.
- **Family billing.** One customer per bill; another family member's prescription is refused with a clear message.
- **Refund policy.** Any staff member on the roster can refund with a reason code; the 7-day frame return window on
  the sample invoice is not enforced. Both are questions for finance/retail.
- **Discount split and GST.** A flat cart or pair discount is split across frame (18%) and lens (5%) in
  proportion to value, which changes the tax due compared with putting it all on the frame (what the old bills
  did). Finance should confirm.
- **Remakes** (zero-value lens orders with `parent_invoice_no`) are understood by the day-end but not created by
  this till.

## What I'd do next

1. Cash till: open with a float, cash sales and refunds recorded automatically, paid-in/paid-out with reasons,
   close with a count, variance over ₹200 flagged.
2. Partial refund (frame only / lens only), which needs line-level refund tracking.
3. Audit trail endpoint, then the printable invoice.
4. Webhooks + pagination so the day-end and lookups don't scan orders.

## Where AI helped and where it misled

<!-- Draft from the build log. Rewrite in your own words before submitting. -->

I built this with Claude Code. It helped most with the volume of careful work: zod schemas for every upstream
shape, the Shopify mapping, and tests that script failures (write-then-timeout, lost terminal answers).

It also got things wrong, and the tests caught them:

- **Double order on double click.** The first checkout allowed only one invoice per cart, but two simultaneous
  requests both drove that invoice forward and created two Shopify orders. A race test failed; fixed with one
  driver per bill.
- **A safety check that could be skipped.** The first refund flow used "has an error" to decide whether
  Shopify's refund calculation had already passed, so if the check itself failed, a resume would skip it and pay
  out unchecked. Fixed with an explicit `checked` flag and a test for exactly that path.
- **Blaming the caller for upstream data.** A zod failure on Shopify's location list (HQ has a null invoice prefix)
  came back as a 400 Bad Request. Now a 502.
- **Wrong arithmetic in tests.** Twice the expected value in a test was miscalculated by hand (a tax total, a
  date-based offer set) while the code was right. Expected values for money are now cross-checked against the
  Python reference in `validate_seed.py`.
- **Over-trusting the data.** The obvious reading of "latest prescription" is the newest one; the seed has
  prescriptions dated in the future, and the newest is not always the one to bill against.
