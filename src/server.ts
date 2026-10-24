import { describeUpstreams, envWarnings, loadEnv } from "./config/env.js";
import { compose } from "./compose.js";
import { createApp } from "./api/app.js";

const env = loadEnv();
for (const w of envWarnings(env)) console.warn(`warning: ${w}`);
const deps = compose(env);

const server = createApp(deps).listen(env.PORT, () => {
  console.log(`eluno-till API on http://localhost:${env.PORT}`);
  console.log(`  upstreams: ${describeUpstreams(env)}`);
  console.log(`  till db: ${env.DB_PATH}`);
});

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
