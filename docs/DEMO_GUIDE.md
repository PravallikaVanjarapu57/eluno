# Eluno POS — Demo Guide

A walkthrough for showing the till to a technical stakeholder, including how to reproduce upstream failures (HTTP 429 and 503) and recover safely.
Everything here was checked against the code. Where a step was actually run, it says **Verified**; where it is read from the code only, it says **From the code**.

> **Everything in this demo talks to mocks.** Shopify, the store tool (prescriptions, staff) and the payment terminal are all one Python process
> (`backend/starter-kit/mock-apis/mock_server.py`) holding state in memory. A "captured" UPI or card payment is a record in that process.
> **No real money moves and no real Shopify store is touched.** Real Shopify and a real terminal would differ (see section A and the notes in each part).

---

## A. Overview

**What it is.** A browser/tablet till that replaces Shopify POS for an optical retailer. Shopify stays the system of record for customers, stock, orders and refunds; prescriptions and staff come from a separate store-management tool; payments go to a card/UPI terminal.

**A sale.** The salesperson signs in, finds or creates the customer, picks the prescription, picks a frame and a lens, and the server validates that lens against the prescription (a lens the lab cannot make is refused with a reason). The server prices the cart (offers, GST, an optional manager discount); the browser only displays it. Charging numbers the invoice, asks the terminal to take the payment, then posts the order to Shopify. Each step is saved before the next external call, so an interrupted checkout can be resumed without charging or numbering twice.

**Customers and prescriptions.** Customers live in (mock) Shopify, prescriptions in the (mock) store tool; the till stores neither. Staff can search, create and edit customers, add prescriptions (always as new records), and start a sale from a customer profile.

**After the sale.** A refund (full, in v1) is reviewed, confirmed, and recorded as a credit note: frames go back into stock at the bill's store, lenses do not (they are made to order), and GST is reversed per line. Day-end shows one store's sales, refunds, payment methods, GST and a reconciliation of Shopify against the till's own ledger; managers can download it as CSV.

**Parts.**

| Part | Technology | Role |
|---|---|---|
| `frontend/` | React + TypeScript + Vite | The UI. Holds no business rules; calls only `/api/*` on its own origin |
| `backend/` | Node.js + Express + TypeScript | The till API: rules, sessions, adapters, checkout state machine |
| SQLite (`backend/data/till.db`) | `better-sqlite3` | The till's own state: carts, bills, credit notes, audit log, users, sessions, invoice series |
| Mock upstreams | `mock_server.py` (Python 3, no packages) | Stands in for Shopify Admin REST, the store tool and the terminal on one port |

**Mock versus real.** Real Shopify would paginate with cursors, rate-limit by call budget, and have a fuzzier search. A real terminal would have real latencies and declines. The failure behaviours below are the mock's models of those, not recordings of the real systems.

---

## B. Prerequisites

*From the code (`backend/package.json`, `dev.sh`, `backend/run.sh`, `backend/src/config/env.ts`).*

| Need | Detail |
|---|---|
| Node.js | 20 or newer (`engines.node >= 20`) |
| Package manager | npm (`package-lock.json` in `backend/` and `frontend/`; use `npm ci`) |
| Python | Python 3 (the mock uses only the standard library; `backend/run.sh` says 3.8+) |
| Ports | **3000** till API (`PORT`), **8787** mock (`MOCK_PORT`), **5173** Vite UI (dev only) |
| Environment variables | None required locally. `AUTH_DEMO_PASSWORD` (12+ characters) is optional; if unset a random password is printed once at startup |
| Database | `backend/data/till.db` is created on first start with its migrations (schema version 6). Set `DB_PATH` to use another file |
| Secrets | None. The mock ignores `SHOPIFY_ACCESS_TOKEN`; do not set real Shopify, terminal or registry credentials for this demo |

---

## C. Start the application

```bash
cd backend  && npm ci
cd frontend && npm ci
```

**Normal development environment** (mock without random failures + API + UI). **Verified.**

```bash
./dev.sh
```

**Failure-injection environment** (mock with seeded-random 429/503). **Verified** (`npm run start:flaky`, which `./dev.sh --flaky` runs).

```bash
./dev.sh --flaky
```

**For repeatable demos, start from a clean state** and choose your own password. **Verified** (`TILL_RESET_DB`, `AUTH_DEMO_PASSWORD` and `MOCK_FAIL` all behaved as described):

```bash
TILL_RESET_DB=1 AUTH_DEMO_PASSWORD='choose-12-chars-or-more' ./dev.sh
```

`TILL_RESET_DB=1` deletes the till's SQLite file when the script starts its own mock. Without it, an old `data/till.db` (bills, invoice series) outlives the mock (which always restarts from the seed) and the two disagree.

**Scripted, deterministic failures** (section F) are switched on with `MOCK_FAIL`; for example:

```bash
TILL_RESET_DB=1 MOCK_FAIL="429:orders.json:2" ./dev.sh
```

**Single origin, as production does** (UI served by the API). **From the code:**

```bash
cd frontend && npm run build
cd ../backend && TILL_RESET_DB=1 npm start      # open http://localhost:3000
```

**URLs**

| What | URL |
|---|---|
| UI (dev) | http://localhost:5173 (Vite forwards `/api` to :3000) |
| UI (single origin) | http://localhost:3000 (after `npm run build`) |
| Till API | http://localhost:3000/api (health: `curl http://localhost:3000/api/health`) |
| Mock | http://localhost:8787 (health: `curl http://localhost:8787/health`) |

`/api/health` returns `{"ok":true,"offers":8,"tax_rates":7,"db_schema_version":6}` (**Verified**).

**Sign-in password.** If you did not set `AUTH_DEMO_PASSWORD`, find `demo password for this run` in the backend output. Never commit it.

**Stopping.** Ctrl+C in the terminal running `dev.sh` stops all three processes. **Data on restart:** the mock's state (customers, orders, stock, prescriptions, charges) is in memory and returns to the seed. The SQLite file stays unless `TILL_RESET_DB=1` is set.

---

## D. Demo data

All from `backend/starter-kit/data/*.json` (**Verified** against the files).

**Sign in** with the staff id in lower case and the run's password. Roles come from the staff roster. Optometrists have no login.

| Username | Person | Role | Store |
|---|---|---|---|
| `s105` | Vikram R. | Salesperson | HSR (Eluno HSR Layout) |
| `s108` | Meera P. | Store manager | HSR |
| `s109`, `s112` | | Salesperson, store manager | BR (Eluno Bel Road) |

Other stores: MM (Mantri Mall), KMG (Koramangala), JN (Jayanagar), IN (Indiranagar), VC (Vega City), HQ. Each user has one store and sees only that store's bills and report.

| Customer (mobile) | Name | What it shows |
|---|---|---|
| `9000000005` | Karthik Reddy | Priority customer, campaign `progressive_oct26`, **valid** prescription RX5007 (2026-07-10 to 2027-07-10). The main sale demo |
| `9000000000` | Priya Nair | Only prescription RX5001 is **expired** (valid until 2026-07-16): lens billing is blocked |
| `9000000017` | Deepak Verma | RX5026 valid until 2026-11-10 and RX5027 expired: some lenses are invalid for his strong power |
| `9000000012` | Kavya Hegde | RX5017 expired, RX5019 expired, RX5018 **future-dated** (2026-11-29): the "newest" is not billable |

**Catalogue used below.** Frame FR-0003 *Eluno Atelier Rectangle 03 Tortoise* (variant 91000003, ₹10,998.00, Rx-able); lens LN-0043 *Progressive 1.60 blue_cut* (variant 91000083, ₹9,499.00, needs ADD 0.75 to 3.0).

**Existing invoices.** The seed already holds orders `#1001`-`#1012`. HSR's invoices `ELU/HSR/FY26/00001` and `00002` exist, so **the first sale you make at HSR is `ELU/HSR/FY26/00003`** and becomes Shopify `#1013` (**Verified**). `ELU/HSR/FY26/00002` is already refunded; for a refund demo, refund the bill you just made.

**Business date.** The till uses today's date in IST (override with `TILL_TODAY=YYYY-MM-DD`). The prescription statuses above are as of late October 2026; on a much later date, "valid" prescriptions will have expired. Set `TILL_TODAY=2026-10-23` to pin the date the tests use.

---

## E. Normal sales walkthrough (salesperson `s105`)

Expected values below for Karthik were checked against the quote API and the automated test `test/integration/checkout.test.ts`; the clicks were run in a browser on a clean mock with other data (Amit Shah, `s108`), reaching `POSTED` as `ELU/HSR/FY26/00003`, Shopify `#1013`.

1. **Sign in.** Open http://localhost:5173, enter `s105` and the password. *Point out:* roles come from the server's session, not the browser; the top bar shows name, role and store.
2. **Store and staff.** A salesperson has one store, so it is selected (HSR). The *Billed by* field shows the signed-in staff and cannot be edited. *Point out:* nobody can bill as someone else.
3. **Find the customer.** *New sale* → mobile `9000000005` → **Look up**. *Expected:* Karthik Reddy, "Priority customer", campaign pill, previous orders.
4. **Review the prescription.** The card shows RX5007, OD/OS grid, "In force until 2027-07-10". *Point out:* validity is computed on the server; an expired one (try `9000000000`) blocks lens billing with a clear message.
5. **Start the sale.** Choose a channel (Walk-in is fine) → **Start sale**.
6. **Frame.** Search "Rectangle" → pick FR-0003. *Point out:* stock at this store is shown; sunglasses are marked "not for prescription lenses".
7. **Lens.** Pick LN-0043 *Progressive 1.60 blue_cut*. *Point out:* every lens is marked valid or invalid for this prescription, with the reason; picking an invalid one is refused by the server. Then **Add to cart**.
8. **Quote.** The cart shows the pair and *Offers, GST and total*. *Expected for this sale (**Verified** against the quote API):* offers "Free blue-cut upgrade on progressive 1.60+", "Priority customer ₹500 off" and "₹300 off when frame and lens billed together"; discounts ₹1,800.00, GST ₹1,996.93, **payable ₹18,697.00**, the same on any channel. *Point out:* every offer is listed with why it did or did not apply; paise arithmetic is exact; none of this is computed in React.
9. **Manager discount (optional).** Salespeople see "ask a manager"; sign in as `s108` to apply one with a reason code. The signed-in manager is the approver.
10. **Pay.** Choose **UPI** → **Charge** → **Yes, charge** (a confirm step). *Expected:* "Sale complete · ELU/HSR/FY26/00003 — Confirmed in Shopify as #1013". *Point out:* success is shown only when the bill is `POSTED`; the terminal is a mock, so this is not a real payment.
11. **Verify.** *Refunds* page → recent bills lists the invoice; or `GET /api/bills/ELU%2FHSR%2FFY26%2F00003`. In the mock, `GET http://localhost:8787/admin/api/2026-10/orders/<orderId>.json` shows the order with `invoice_no` and `rx_id` recorded.

Also show **Unfinished bills at this store** on the New sale page: it is the way back into an interrupted checkout.

---

## F. Customer and prescription walkthrough

All implemented (**Verified** in the browser and by `backend/test/integration/customer-management.test.ts`).

1. **List and search.** *Customers* tab: 20 per page with *Load more*, search by name, mobile or email (server-side). Each row shows the latest prescription status and count.
2. **Create.** *Add customer* → mobile, first name (required), last name, email. A duplicate mobile is refused ("already exists", with **Open existing customer**).
3. **Edit.** Open a customer → *Edit customer*. Name and email only; the mobile is read-only (prescriptions and bills are found by it).
4. **History.** The profile lists every prescription, newest first, each with a *Valid*, *Expired* or *Future-dated* label, plus recent bills at your store.
5. **Add a prescription.** *Add prescription* → test date, optional "valid until" (empty means one year after the test, shown in the hint), optional PD, SPH/CYL/AXIS/ADD for each eye. Try CYL without AXIS to see field-level errors. It saves as a new record, "external".
6. **Start a sale from the profile.** *Start sale* → the sale page lists every prescription; expired ones show "Cannot be used". With two or more in force you must pick one; with exactly one it is selected automatically. **Continue to frames and lenses** opens the till with the same cart.
7. **Round trip.** On the sale page choose *Add prescription*, save, and you return to the same cart (remembered on this device; the cart lives on the server).

---

## G. Refund walkthrough

1. **Find the invoice.** *Refunds* → type `ELU/HSR/FY26/00003` (as printed) or pick it under *Or pick from recent bills*, or use *Refund this bill…* on the sale confirmation → **Load bill**.
2. **Review.** The original bill: lines, discounts, GST (CGST/SGST), payment method and charge id, Shopify order.
3. **Initiate.** Choose a reason (for example *Customer changed their mind*) → **Review full refund…** → **Yes, refund in full**. *Point out:* a confirm step guards an irreversible action; the refund is full-bill only in v1.
4. **Result.** A credit note (`CN/…`, numbered after the seed's credit notes; `CN/00003` in the verified run) with status `POSTED`.
5. **What happens.** *From the code* (`domain/refund.ts`): the terminal refund is made against the original charge (it reads what was already refunded first, so it cannot pay out twice); **frames are restocked** at the bill's store; **lenses are not restocked** (`no_restock`); GST is reversed per line by Shopify's own refund calculation; the credit note records it.
6. **Day-end.** As `s108`, Day-end for today shows refunds equal to the sale (**Verified**: after refunding a ₹11,897.20 bill, net after refunds was ₹0).

---

## H. Day-end walkthrough (store manager only)

1. Sign in as `s108` (the nav has **Day-end**; `s105` does not).
2. Pick the store (HSR) and business date (default today, IST) → **Show report**.
3. The report shows bills, gross sales (MRP), discounts, taxable value, GST split, net sales, refunds, net after refunds, payment-method and channel breakdowns, invoice series, discounts by offer, and a **Reconciliation** banner ("Shopify and the till agree" or a list of mismatches). *Verified:* after one ₹11,897.20 sale it read Bills 1, Net sales ₹11,897.20, Reconciled.
4. **Download CSV** (managers only): `eluno-day-end-HSR-<date>.csv`, built from the same figures.
5. **Permissions (Verified).** `s105` cannot see Day-end; `GET /api/reports/day-end.csv` as `s105` returns **403**; a manager of another store gets 403 for HSR.
6. **Cross-check.** Day-end sums should equal the invoices you made (and the mock's `orders.json`). Mismatches are listed, never hidden.

---

## I. Reproducing failures (HTTP 429, 503, and what is not supported)

### What the code can actually produce

| Status | Who returns it | When | Source |
|---|---|---|---|
| **429** | Mock Shopify **writes** (any `POST`/`PUT` under `/admin/api/…`: orders, refunds, customers, inventory) | Seeded-random ~10% in flaky mode, or scripted with `--fail` | `mock_server.py` |
| **503** | Mock terminal `POST /terminal/charges` | Seeded-random ~30% on the first charge for an `order_ref` (once per `order_ref`) in flaky mode, or scripted | `mock_server.py` |
| **429** | The till API's own sign-in throttle (5 wrong passwords lock a username for 15 minutes, `Retry-After` set) | Real behaviour, unrelated to the upstream mocks | `application/auth.ts` (unit and integration tests) |
| **501** | **Nothing.** No code injects or special-cases 501 | n/a | grep over `backend/`, `frontend/` |

**Retry policy** (`backend/src/adapters/http/client.ts`, **From the code**, confirmed by logs below):

- **429:** always retried after `Retry-After` (the mock sends 1.0 s), up to **5 attempts**. A 429 means the request was rejected, so nothing was written.
- **5xx, timeout, dropped connection:** the outcome is unknown. Retried (with jittered backoff, same 5 attempts) **only when the request is safe to repeat**: reads, and writes marked idempotent (the terminal charge, keyed by `order_ref`). For a non-idempotent write such as posting an order, it stops and reports an unknown outcome instead of retrying.
- **Other 4xx:** not retried.
- Then checkout makes up to 3 posting rounds; before any round after an uncertain one it **looks the order up by invoice number**, so it adopts an order that already exists rather than creating another.

**How the mock injects failures.** Two mechanisms, both in `mock_server.py` and neither reachable through the till API:

1. **Random ("flaky") mode:** `./dev.sh --flaky` / `npm run start:flaky` (omit `--no-flake`). It uses a generator seeded with `random.seed(7)`, so a *clean* start with the *same sequence of requests* repeats the same failures. Only some requests draw a number: a `POST /terminal/charges` with an `order_ref` (one draw), and any other `POST`/`PUT` that reaches the Shopify-style routes (one draw). GETs do not draw. Creating or editing a customer also consumes a draw (it is a Shopify write), so any extra Shopify write shifts the sequence. Creating a prescription does not (the store-tool route is answered before the random check).
2. **Scripted mode (added for this guide):** `--fail MODE:PATH:COUNT`, repeatable, or through the till's launcher `MOCK_FAIL="MODE:PATH:COUNT,…"`. The next COUNT `POST`/`PUT` requests (to any mock route, including the terminal and store tool) whose path contains PATH fail, in order, then the mock behaves normally. `MODE` is an HTTP status answered **before** the request is processed, or `drop`: the request **is processed**, then the connection is closed without an answer (the write happened, but the caller cannot know). It is a development-only option of a test double: there is no HTTP endpoint for injecting failures. Examples: `503:terminal/charges:5`, `429:orders.json:15`, `drop:orders.json:1`.

   The mock also now makes `POST /terminal/charges` **idempotent on `order_ref`** (a repeat returns the stored charge). The till already assumed this; before, a repeated charge would have created a second one in the mock.

**Where to look for evidence.** Retries that succeed are invisible in the UI. Watch the terminal running the backend:

```
terminal HTTP 503 on POST terminal/charges; retry 1 in 61 ms
shopify 429 on POST orders.json; retry 1 in 1000 ms
```

(**Verified**; the mock's own console also prints `[scripted failure] 429 on POST /admin/api/2026-10/orders.json (1 more)`.) The audit log and the bill's `lastError` record outcomes the retries could not resolve.

### Failure table

Use a clean start each time (`TILL_RESET_DB=1`), the HSR salesperson `s105`, customer `9000000005`, frame FR-0003 and lens LN-0043, UPI. Each scenario below ends with the same check: **exactly one Shopify order for the invoice number and one charge id on the bill.** Check with `GET /api/bills/<invoice>` and, in the mock, `GET http://localhost:8787/admin/api/2026-10/orders.json?status=any&limit=250` (filter on the `invoice_no` note attribute).

| Scenario | Trigger | Expected response | Expected application behaviour | Recovery and verification |
|---|---|---|---|---|
| **1a. 429 on posting the order, absorbed** | `TILL_RESET_DB=1 MOCK_FAIL="429:orders.json:2" ./dev.sh`, then run the sale | Mock answers 429 + `Retry-After: 1.0` twice | Till waits 1 s, retries, third attempt succeeds. UI just takes ~2 s longer, then "Sale complete" | Backend log shows `shopify 429 on POST orders.json; retry 1 in 1000 ms` and `retry 2`. **Verified.** One order in the mock; bill `POSTED` |
| **1b. 429 outlasts the retries** | `MOCK_FAIL="429:orders.json:15"` (3 posting rounds x 5 attempts) | 15 x 429 | The customer **has paid**. After the rounds the bill is `CHARGED_NOT_POSTED`; UI: "Paid · … · waiting for Shopify", with **Check status** and **Retry posting now**. HTTP 202, never shown as complete | Press **Retry posting now** (or `POST /api/bills/<invoice>/resume`). Safe: it never charges again and looks the order up first. Bill becomes `POSTED`, same `chargeId`, one order. **Verified** in `test/integration/failure-injection.test.ts` (API level, not clicked) |
| **1c. 429 from the seeded generator** | `TILL_RESET_DB=1 ./dev.sh --flaky`, make four sales in a row with **no other writes** (no customer or prescription creation) | See "Seeded sequence" below | Checkouts 2 and 3 show one 429 on `orders.json`; checkout 4 shows a 503 then two 429s; all succeed | Same logs. **Verified** (four sales via the API against `start:flaky`) |
| **2a. 503 on the terminal charge, absorbed** | `MOCK_FAIL="503:terminal/charges:2"` | 503 twice | The charge is idempotent on `order_ref`, so it is retried automatically (jittered backoff, a few ms), third try succeeds. Sale completes | Backend log `terminal HTTP 503 … retry 1/2`. **Verified.** One charge, one order |
| **2b. 503 outlasts the retries (payment status unknown)** | `MOCK_FAIL="503:terminal/charges:5"` | 5 x 503 | Bill is numbered but not paid: status `NUMBERED`, `lastError: "Payment status unknown …"`, HTTP 202. UI: "Payment not confirmed · INV", with **Check status**, **Resume (check terminal again)**, **Cancel bill…** | **Check the terminal first.** **Resume** asks the terminal again with the same `order_ref` (cannot double-charge); it pays once and posts one order. **Cancel** is allowed only while `NUMBERED` (unpaid); once paid, use a refund. **Verified** via API in `failure-injection.test.ts` |
| **2c. Terminal captured, answer lost** | `MOCK_FAIL="drop:terminal/charges:1"` | Connection closed after capture, no HTTP status | The client cannot tell. It retries the same `order_ref`; the mock returns the **same** charge | Bill `POSTED` with one `chargeId`; replaying the charge with the same `order_ref` returns that id. **Verified** in `failure-injection.test.ts` |
| **3. Order created, answer lost** | `MOCK_FAIL="drop:orders.json:1"` | Connection closed after the order was created | Posting an order is not blindly retried. The bill goes to `CHARGED_NOT_POSTED`, then the next round looks the order up by `invoice_no` and **adopts** it | Audit shows `bill.post_failed` then `bill.posted` with `adopted: true`; exactly one order. **Verified** in `failure-injection.test.ts` |
| **4. Sign-in throttle (the till's own 429)** | Enter a wrong password 5 times for one username | `429` `TOO_MANY_LOGINS` with `Retry-After` | "Too many attempts" on the login screen; the right password is also refused until the lock ends (15 minutes) | Wait, or restart the backend (the counter is in memory). Covered by `auth.test.ts` |
| **5. HTTP 501** | **Not supported** | n/a | There is no 501 scenario in the demo | See below |

**Seeded sequence (scenario 1c), derived and checked.** The first generator values are 0.324, 0.151, 0.651, 0.072, 0.536, 0.366, 0.058, 0.507, 0.037, 0.434, 0.070, 0.091, 0.425. A terminal charge fails (503) if its draw is below 0.3 (first try per `order_ref`); a Shopify write fails (429) if below 0.1. From a clean start, four sales produced exactly: checkout 1 clean (draws 1, 2); checkout 2: one 429 on `orders.json` (draws 3, 4, 5); checkout 3: one 429 (6, 7, 8); checkout 4: 503 on the charge, then two 429s on the order (9 to 13). **Verified** with the unmodified Python 3 on the demo machine; a different request order changes the result. For anything you need to show reliably, use scripted mode instead.

### Telling the failure kinds apart

- **A service temporarily failing** (429, or 503 before anything was done): the request was not carried out; retry is safe.
- **A request with no definitive result** (timeout, dropped connection, repeated 5xx): the action may have happened. Never repeat it blindly. The till looks the thing up (the order by invoice number, the charge by `order_ref`) or asks staff to *Check status* / *Resume*.
- **A definitive rejection** (a 4xx such as 422): the terminal or Shopify refused. A refused charge cancels the unpaid bill ("Not paid · … cancelled", the number stays in the series as cancelled); a refused order leaves the bill `CHARGED_NOT_POSTED` with the reason in `lastError`.

### About HTTP 501

501 (Not Implemented) means the server does not support the operation. It is **not** a transient availability error and is not the same as 503. **The current demo does not include it**, and no code in the till special-cases it. For information only: the HTTP client treats every status of 500 and above as "outcome unknown", so a 501 would currently be **retried automatically** like a 503. An ad-hoc run with `--fail 501:terminal/charges:3` (not part of the test suite) was retried and ended `POSTED`. If the stakeholder wants 501 shown, the correct change is separate from this demo: treat 501 as a definitive "operation not supported" (no retry, a clear message), then add a scripted scenario for it. That would change retry behaviour and has not been done.

### Verification checklist after any failure scenario

- The expected status was observed (backend log lines above, or the bill state in the UI).
- The UI showed a meaningful state, never "complete" unless `POSTED`.
- Retries were bounded (at most 5 attempts per request, 3 posting rounds).
- The invoice number did not change and the `chargeId` did not change after recovery.
- Exactly one order in the mock for that invoice; the order count at `GET …/orders.json?status=any` rose by one per sale, not two.
- Day-end for the store shows the sale once and "Reconciled".

---

## J. Presenter checklist

- [ ] Start with `TILL_RESET_DB=1 AUTH_DEMO_PASSWORD=… ./dev.sh`; `curl localhost:3000/api/health` and `curl localhost:8787/health` return OK.
- [ ] Sign in as `s105` (salesperson, HSR) and as `s108` (manager, HSR) in separate windows.
- [ ] Run one normal sale for `9000000005`; confirm `ELU/HSR/FY26/00003`, payable ₹18,697.00, status `POSTED`.
- [ ] Verify the order in the mock and the bill via `GET /api/bills/…`.
- [ ] Show the customer list, add a prescription, start a sale from a profile.
- [ ] Refund the bill (reason, confirm) and open the credit note.
- [ ] As `s108`, open Day-end, check Reconciled and net-after-refunds, download the CSV; show `s105` cannot.
- [ ] Restart clean with `MOCK_FAIL="429:orders.json:2"`; run a sale; point at the 429 retry lines in the backend log.
- [ ] Restart clean with `MOCK_FAIL="503:terminal/charges:5"`; run a sale; show "Payment not confirmed", then **Resume**.
- [ ] Restart clean with `MOCK_FAIL="429:orders.json:15"`; show "waiting for Shopify", then **Retry posting now**.
- [ ] Confirm one order and one charge per invoice after each recovery.
- [ ] State that 501 is not part of the demo and that all upstreams are mocks.
- [ ] Reset: stop everything and start with `TILL_RESET_DB=1` before the next audience.

---

## K. What was and was not verified

**Run and observed:** `./dev.sh` start and `/api/health`; a full browser sale, refund and day-end on a clean mock; the seeded 429/503 sequence over four sales; scripted 503 x2 and 429 x2 through `npm start` with `MOCK_FAIL` (log lines quoted above); all scenarios in the failure table marked Verified by `backend/test/integration/failure-injection.test.ts` (seven tests, API level); the ad-hoc 501 run.

**Not run in a browser:** the recovery screens for scenarios 1b, 2b, 2c and 3 (the UI states come from `frontend/src/components/BillStatus.tsx` and the status values above were observed through the API); the sign-in lockout was seen live earlier on the hosted demo but is tested in the suite.

**Known limits:** the mock's failures are models, not recordings of Shopify or a real terminal; the seeded sequence depends on request order; the till's SQLite file and the mock's memory must be reset together.
