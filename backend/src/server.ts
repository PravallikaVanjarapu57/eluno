import { randomBytes } from "node:crypto";
import path from "node:path";
import { describeUpstreams, envWarnings, loadEnv } from "./config/env.js";
import { compose } from "./compose.js";
import { createApp } from "./api/app.js";

const env = loadEnv();
for (const w of envWarnings(env)) console.warn(`warning: ${w}`);
const deps = compose(env);

const server = createApp(deps, { staticDir: path.resolve(env.FRONTEND_DIR) }).listen(env.PORT, () => {
  console.log(`eluno-till API on http://localhost:${env.PORT}`);
  console.log(`  upstreams: ${describeUpstreams(env)}`);
  console.log(`  till db: ${env.DB_PATH}`);
});

// Accounts come from the store-tool roster plus a password supplied at run time (never committed, never over HTTP).
// Development without AUTH_DEMO_PASSWORD: a random password for this run is generated and shown once.
// Done after the port is bound, so a slow start (many password hashes on a small CPU) never delays the health check.
const generated = env.AUTH_DEMO_PASSWORD === undefined && env.NODE_ENV !== "production";
const demoPassword = env.AUTH_DEMO_PASSWORD ?? (generated ? randomBytes(9).toString("base64url") : undefined);
if (demoPassword) {
  deps
    .provision(demoPassword)
    .then((r) => {
      console.log(`accounts: ${r.created} created, ${r.updated} updated, ${r.unchanged} unchanged, ${r.deactivated} disabled (username = lower-case staff id, e.g. s105)`);
      if (generated) console.log(`demo password for this run (all accounts): ${demoPassword}`);
    })
    .catch((e: unknown) => console.error("could not provision accounts (is the store tool up?):", (e as Error).message));
} else {
  console.warn("warning: AUTH_DEMO_PASSWORD is not set and NODE_ENV=production: no accounts are created or refreshed.");
}

// Recovery sweep: bills that were paid but not yet confirmed by Shopify (crash, Wi-Fi drop, outage).
// Runs at startup and every minute; it only posts, it never charges.
const sweep = async () => {
  try {
    const bills = await deps.checkout.resumePending();
    const refunds = await deps.refunds.resumePending();
    const done = [...bills.map((b) => `${b.invoiceNo} ${b.status}`), ...refunds.map((c) => `${c.creditNoteNo} ${c.status}`)];
    if (done.length) console.log(`recovery: ${done.join(", ")}`);
  } catch (e) {
    console.error("recovery sweep failed:", e);
  }
};
void sweep();
const timer = setInterval(sweep, 60_000);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    clearInterval(timer);
    server.close();
    deps.db.close();
    process.exit(0);
  });
}
