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
http://localhost:3000. The API serves `frontend/dist` (`FRONTEND_DIR`, default `../frontend/dist`).

Using the UI: choose a store and a staff member at the top (try **HSR**), then **New sale**. Seed customers: `9000000005`
(priority, valid prescription, progressive lens), `9000000017` (SPH -5.25: some lenses are invalid for them), `9000000000` (expired prescription).
Refunds take an invoice number like `ELU/HSR/FY26/00003` (or pick a recent bill); the numbers are shown after each sale.

## Checks

```bash
cd backend  && npm test && npm run typecheck && npm run lint     # 249 tests
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
- **No authentication.** Anyone with the URL can bill and refund against the mock. Acceptable for a demo; not for real Shopify.
- Set `MOCK_FLAKE=1` to make the mock return random 429/503 for failure testing. Render sets `PORT` itself.
- Real Shopify would need `SHOPIFY_BASE_URL`, `SHOPIFY_ACCESS_TOKEN`, `SMT_BASE_URL`, `TERMINAL_BASE_URL` (server-side only) and order pagination (see backend README).
