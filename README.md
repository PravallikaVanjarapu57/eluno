# Eluno till

A browser/tablet till that replaces Shopify POS. Shopify stays the system of record.

```
backend/    Express + TypeScript till API: domain rules, Shopify/store-tool/terminal adapters, SQLite, tests, the starter-kit mock
frontend/   React + TypeScript + Vite UI: New sale, Refunds, Day-end
Dockerfile  one container: API + built UI on one origin, mock beside it
```

The UI holds no business rules. Offers, GST, prescription validation, payment orchestration and refunds all come from the
API; the browser only calls `/api/*` on its own origin and never reaches Shopify, the store tool or the terminal.
Backend details (architecture, decisions, known gaps) are in [`backend/README.md`](backend/README.md).

## Run locally

Needs Node.js 20+ and Python 3 (for the supplied mock).

```bash
./dev.sh            # mock :8787 + API :3000 + Vite UI :5173   ->  open http://localhost:5173
./dev.sh --flaky    # same, with the mock returning random 429s and terminal 503s
```

Or by hand, in three terminals:

```bash
cd backend  && npm ci && npm start          # starts the mock (:8787) and the API (:3000); `npm run start:flaky` injects failures
cd frontend && npm ci && npm run dev        # UI on :5173, proxies /api -> http://localhost:3000
```

Single-origin (what production does): `cd frontend && npm ci && npm run build`, then `cd backend && npm start` and open
http://localhost:3000. The API serves `frontend/dist` (`FRONTEND_DIR`, default `../frontend/dist`) and then lives only under `/api`.

## Signing in (demo accounts)

Everything except `/api/health` and sign-in requires a session. There is **no sign-up** and no way to create or promote an
account over HTTP. Accounts are provisioned by the operator when the server starts:

- One login per **salesperson** and **store manager** on the store-tool roster (the mock has 14 + 7), at a store that bills.
  Identity, role and store come from the roster. **Optometrists have no login**: only two roles are approved.
- The username is the lower-case staff id (`s105` salesperson at HSR, `s108` store manager at HSR, `s109` / `s112` at BR, ...).
- The password is supplied at run time and is never in the repository:
  - **Local:** if `AUTH_DEMO_PASSWORD` is unset, `npm start` generates a random password and prints it **once** in the backend
    output (`demo password for this run`). Or choose your own: `AUTH_DEMO_PASSWORD='at-least-12-chars' ./dev.sh`.
  - **Production** (`NODE_ENV=production`): `AUTH_DEMO_PASSWORD` is required, otherwise no account exists and nobody can sign in.
- Re-running with the same password changes nothing; a new password re-hashes the accounts; staff who leave the roster are disabled.
- **The deployed demo:** its password is the `AUTH_DEMO_PASSWORD` environment variable of the Render service
  (dashboard → eluno-till → Environment). It is not in this repository, the image, or the logs. Share it with reviewers privately.

| Capability | Salesperson | Store manager |
|---|---|---|
| Look up customers, **create customers** | yes | yes |
| Cart, lens validation, offers, checkout, recover an unpaid bill (own store) | yes | yes |
| Full refund (own store's bills) | yes\* | yes |
| Apply a **manager discount** (the signed-in manager is the approver) | **no** | yes |
| View the **day-end report** on screen | **no**\* | yes (own store) |
| **Download** the day-end report (CSV) | **no** | yes (own store) |
| Create or change **lens validation rules** | **no** | **no** (nobody) |
| Anything in another store | no | no |

Every row is enforced by the API (`backend/src/domain/auth.ts`, `backend/src/api/app.ts`, the route files); the UI only hides what the
server would refuse. \* = see *Open questions*. Store managers can do everything a salesperson can; a user belongs to one store.

### How it works

- **Sessions:** server-side, in SQLite. Sign-in verifies a **scrypt** hash (never plaintext), then issues a random 256-bit token as an
  **HttpOnly, SameSite=Strict** cookie (**Secure** and `__Host-` prefixed in production). Only the token's SHA-256 is stored.
  Idle timeout 2 h, absolute 12 h (`AUTH_IDLE_MINUTES`, `AUTH_MAX_HOURS`). Sign-out deletes the session on the server.
- **CSRF:** every write needs the session's CSRF token in `X-CSRF-Token` (returned by sign-in and `/auth/me`, held **in memory** by the page,
  never in localStorage) and a same-site `Origin` when the browser sends one.
- **Nothing is trusted from the client:** role, staff id, store and approver are read from the session. A `staffId` or `approverId`
  in a request body is ignored (or must equal the signed-in user). Bills, refunds and the audit log record the signed-in staff.
- **Brute force:** 5 wrong passwords lock a username for 15 minutes (429 + `Retry-After`). Unknown users cost the same time as wrong passwords.
- **Responses:** `401` not signed in / session ended, `403` signed in but not allowed (`FORBIDDEN`, `STORE_FORBIDDEN`, `CSRF_INVALID`, `LENS_RULES_LOCKED`).

### Customers and reports

- **New customer** (New sale → *New customer…*, or offered when a lookup finds nobody): `POST /api/customers` through the Shopify adapter.
  The phone is normalised and must be unique: an existing customer is refused without a write (`409 CUSTOMER_EXISTS`, with *Use existing customer*),
  two tills creating the same number at once are settled by Shopify's own uniqueness check, and an uncertain write (timeout/5xx) is **never retried
  blindly**: the UI offers *Check whether they exist*. The new customer can be billed immediately.
- **Day-end download** (managers): Day-end → *Download CSV* calls `GET /api/reports/day-end.csv?store=&date=`, built from the same report
  object as the screen (`backend/src/domain/dayEndCsv.ts`), as `eluno-day-end-<store>-<date>.csv`. Columns: `section,item,count,amount_paise,amount_inr,detail`
  with sections `report, sales, refunds, net, payment_method, channel, discount_by_offer, invoices, mismatch`. A test checks every total
  and the payment-method breakdown against the JSON report. Text cells starting with `= + - @` are neutralised against spreadsheet formula injection.

## Using the UI

Sign in (above), then **New sale**. Seed customers: `9000000005` (priority, valid prescription, progressive lens), `9000000017` (SPH -5.25: some lenses
are invalid for them), `9000000000` (expired prescription), or create your own. Refunds take an invoice number like `ELU/HSR/FY26/00003`
(or pick a recent bill); the numbers are shown after each sale. Managers also get **Day-end**.

## Checks

```bash
cd backend  && npm test && npm run typecheck && npm run lint
cd frontend && npm test && npm run typecheck && npm run build
```

## Reliability in the UI

- Reads (lookups, quote, reports) are retried by the browser on 429/502/503 with backoff. **Charges, refunds and every other
  write are never retried by the browser.**
- `202` from checkout/refund is shown as *in progress*, never as a completed sale; `402` is shown as declined, with the invoice
  number consumed. Success is displayed only for `POSTED`.
- If the answer to "charge" or "refund" is lost, the UI asks the server (`GET /carts/:id/bill`, `GET /bills/:no/refunds`) instead of resending.
- Unconfirmed bills offer **Check status**, **Resume** (the server asks the terminal again with the same `order_ref`, which cannot double-charge)
  and **Cancel**. A reload restores the sale in progress, and **Unfinished bills** lists numbered or paid-but-unposted bills.
- The Charge button needs a confirm step and is locked while a request is in flight.

## Deploy (free tier)

The `Dockerfile` builds one image: the API serves the UI at `/` and the API at `/api`, with the mock running beside it.
Verified locally (`docker build`, run with `PORT=10000`, lookup → checkout → refund → day-end, UI and `/api/health`), for both
`linux/arm64` and `linux/amd64`. **Render runs amd64**, so build for it explicitly:

```bash
docker buildx build --platform linux/amd64 -t <registry>/<user>/eluno-till:latest --push .
```

**Without connecting a Git repository**, Render's documented route is an *image-backed* web service: Render pulls a prebuilt
image from a container registry on each deploy (Dashboard: New → Web Service → *Existing Image*; API: `POST /v1/services`
with `image.imagePath` and `serviceDetails.runtime: "image"`). Render has no documented way to upload local source or a local
image, so a registry (Docker Hub, GHCR, …) is required; a private one also needs a Render registry credential.
`render.yaml` is a Git-based Blueprint and is **not** used by that route. Note the image contains the full source: make a pushed image
public only if that is acceptable.

**Deployed (demo, mock only):** https://eluno-till.onrender.com — Render free web service `eluno-till`, pulling the public image
`ghcr.io/pravallikavanjarapu57/eluno-till:latest` (linux/amd64). To redeploy: rebuild and push that tag, then trigger a deploy
(Render pulls the image on every deploy). The first request after idle takes about a minute.

Constraints of a free instance:

- **State is ephemeral and resets together.** The till's SQLite file and the mock's in-memory Shopify live in the container.
  The container sets `TILL_RESET_DB=1`, so each start begins with an empty database *and* a fresh mock; otherwise a restart that
  kept the disk would leave bills the mock no longer has (day-end would show `MISSING_IN_SHOPIFY`). A free instance also sleeps
  after 15 idle minutes (~1 min to wake), which resets the demo.
- **Single instance only**: the one-driver-per-bill guard is in-process. Do not scale out.
- **Sign-in is required** (see above). Set `AUTH_DEMO_PASSWORD` as a secret environment variable of the service; without it no account exists. `NODE_ENV=production` and `TRUST_PROXY=1` are baked into the image (Secure cookies behind Render's TLS proxy); for plain-HTTP local use of the image add `-e COOKIE_SECURE=0`.
- Set `MOCK_FLAKE=1` to make the mock return random 429/503 for failure testing. Render sets `PORT` itself.
- Real Shopify would need `SHOPIFY_BASE_URL`, `SHOPIFY_ACCESS_TOKEN`, `SMT_BASE_URL`, `TERMINAL_BASE_URL` (server-side only) and order pagination (see backend README).

## Mock-only demo security vs production readiness

This is a **demo against a mock**, secured sensibly, not a production identity system.

| Done | Not done / would change for production |
|---|---|
| Server-side sessions, scrypt hashes, HttpOnly/Secure/SameSite cookies, CSRF, store scoping, audit of who did what | One shared demo password for all accounts; real staff need individual credentials, a reset flow and ideally SSO/MFA |
| Login throttling per username | No per-IP limit or CAPTCHA; a lock can be triggered against a username by anyone who can reach the API |
| Roles read from the roster at provisioning | A role change in the store tool only takes effect on the next provisioning run (restart); no admin screen for users |
| Single instance, in-memory login throttle | Several instances need a shared throttle and a shared database (the till already assumes one instance) |
| scrypt cost 2^14 on the free demo (2^15 default) | Use at least the default, tuned to real hardware |
| HTTPS from Render's edge | The Postman collection predates sign-in and no longer works unauthenticated |

## Open questions for the client

1. **Who administers lens validation rules?** Store manager, an optometry manager or a separate administrator is undecided. Until it is, **no role can
   create or change them**: the rules live in code/config and every write to the catalogue/config area (`PUT/POST/PATCH/DELETE`, and any `lens-rules` path)
   returns `403 LENS_RULES_LOCKED` for everyone, including managers. Salespeople only select valid lenses and see the validation errors.
2. **May salespeople see the day-end report on screen?** Not stated. Conservatively, the on-screen report is manager-only too (`report:view`);
   this is one line in `backend/src/domain/auth.ts` to change.
3. **Who may issue refunds?** Unchanged from before: any signed-in staff member at the bill's store, with a reason code, attributed to them.
   The earlier question to finance (managers only?) is still open.
4. **Manager discounts** now need the **manager's own sign-in** on the till (they are the approver). Is that acceptable at the counter, or is a manager PIN wanted?
5. **Optometrists** have no login because only two roles were approved. Do they need one (e.g. to record prescriptions)?
