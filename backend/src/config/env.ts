import { z } from "zod";

// An empty variable (SHOPIFY_ACCESS_TOKEN=) means "not set".
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

const EnvSchema = z
  .object({
    PORT: z.coerce.number().int().nonnegative().default(3000),
    // Shopify Admin API host: https://<shop>.myshopify.com in production; the starter-kit mock serves it on :8787.
    SHOPIFY_BASE_URL: z.url().default("http://localhost:8787"),
    SHOPIFY_API_VERSION: z.string().regex(/^\d{4}-\d{2}$/, "expected YYYY-MM").default("2026-10"),
    // Admin API access token, sent as X-Shopify-Access-Token to Shopify only. The mock ignores it; real Shopify requires it.
    SHOPIFY_ACCESS_TOKEN: optional(z.string().min(1)),
    // Store tool (prescriptions, staff) and payment terminal. They default to SHOPIFY_BASE_URL because the
    // starter-kit mock serves all three on one port; in production each is its own system.
    SMT_BASE_URL: optional(z.url()),
    TERMINAL_BASE_URL: optional(z.url()),
    DB_PATH: z.string().default("data/till.db"),
    CONFIG_DIR: z.string().default("config"),
    // Pins the business date (YYYY-MM-DD, IST) for demos against the seed data; unset = today in IST.
    // Built frontend to serve at `/` (single origin with the API under /api). Ignored when the folder is missing.
    FRONTEND_DIR: z.string().default("../frontend/dist"),
    TILL_TODAY: optional(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  })
  .transform((e) => ({
    ...e,
    SMT_BASE_URL: e.SMT_BASE_URL ?? e.SHOPIFY_BASE_URL,
    TERMINAL_BASE_URL: e.TERMINAL_BASE_URL ?? e.SHOPIFY_BASE_URL,
  }));

export type Env = z.output<typeof EnvSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return EnvSchema.parse(source);
}

const isLocal = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(url);

/** Startup warnings for configurations that will fail against real systems. Never includes the token itself. */
export function envWarnings(env: Env): string[] {
  return !env.SHOPIFY_ACCESS_TOKEN && !isLocal(env.SHOPIFY_BASE_URL)
    ? [`SHOPIFY_BASE_URL is ${env.SHOPIFY_BASE_URL} but SHOPIFY_ACCESS_TOKEN is not set; Shopify will answer 401.`]
    : [];
}

/** Where each upstream points, for the startup log. */
export function describeUpstreams(env: Env): string {
  return [
    `shopify ${env.SHOPIFY_BASE_URL} (api ${env.SHOPIFY_API_VERSION}, token ${env.SHOPIFY_ACCESS_TOKEN ? "set" : "not set"})`,
    `store tool ${env.SMT_BASE_URL}`,
    `terminal ${env.TERMINAL_BASE_URL}`,
  ].join(", ");
}
