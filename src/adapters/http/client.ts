// Shared JSON-over-HTTP client for the three upstreams (Shopify Admin, store tool, terminal).
//
// Retry policy:
//   429                      -> always retried after Retry-After: the request was rejected, nothing was written.
//   5xx / timeout / network  -> retried only when the request is safe to repeat (GET, or a write the caller
//                               declares idempotent, e.g. a terminal charge keyed by order_ref).
//                               Otherwise AmbiguousWriteError: the write may or may not have happened, and only
//                               the caller can resolve it (e.g. look the order up by invoice_no before re-posting).
//   other 4xx                -> HttpError immediately; retrying will not help.

export type Method = "GET" | "POST" | "PUT" | "DELETE";

export interface HttpRequest {
  method: Method;
  path: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** Safe to send again after an unknown outcome. Defaults to true for GET, false otherwise. */
  idempotent?: boolean;
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
}

export interface HttpClientOptions {
  baseUrl: string;
  name: string;
  maxAttempts?: number;
  timeoutMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  fetch?: typeof fetch;
  /** Sent on every request to this upstream (e.g. an auth token). */
  headers?: Record<string, string>;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  log?: (msg: string) => void;
}

export class HttpError extends Error {
  constructor(
    readonly upstream: string,
    readonly status: number,
    readonly body: unknown,
    readonly request: HttpRequest,
  ) {
    super(`${upstream} ${request.method} ${request.path} -> ${status}: ${JSON.stringify(body)}`);
  }
}

/** A non-idempotent write failed in a way that leaves its outcome unknown. */
export class AmbiguousWriteError extends Error {
  constructor(
    readonly upstream: string,
    readonly request: HttpRequest,
    readonly cause: unknown,
  ) {
    super(`${upstream} ${request.method} ${request.path}: outcome unknown (${describe(cause)})`);
  }
}

export class RetriesExhaustedError extends Error {
  constructor(
    readonly upstream: string,
    readonly request: HttpRequest,
    readonly attempts: number,
    readonly lastError: unknown,
  ) {
    super(`${upstream} ${request.method} ${request.path}: gave up after ${attempts} attempts (${describe(lastError)})`);
  }
}

/** An upstream answered, but not in the shape we rely on. Our bug or theirs; never the caller's. */
export class UpstreamShapeError extends Error {
  constructor(
    readonly upstream: string,
    readonly what: string,
    readonly issues: string,
  ) {
    super(`${upstream} returned an unexpected ${what}: ${issues}`);
  }
}

/** Validate an upstream response body; failures become UpstreamShapeError, not a client 400. */
export function parseUpstream<T>(upstream: string, what: string, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { message: string } } }, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new UpstreamShapeError(upstream, what, r.error.message);
  return r.data;
}

function describe(e: unknown): string {
  if (e instanceof HttpError) return `HTTP ${e.status}`;
  return e instanceof Error ? e.message : String(e);
}

type Outcome =
  | { kind: "ok"; res: HttpResponse }
  | { kind: "throttled"; waitMs: number; err: HttpError } // 429: nothing written
  | { kind: "unknown"; err: unknown } // 5xx, timeout, network: may have been written
  | { kind: "fatal"; err: HttpError };

export class HttpClient {
  private readonly o: Required<HttpClientOptions>;

  constructor(options: HttpClientOptions) {
    this.o = {
      maxAttempts: 5,
      timeoutMs: 8_000,
      baseDelayMs: 250,
      maxDelayMs: 5_000,
      fetch: globalThis.fetch,
      headers: {},
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      random: Math.random,
      log: () => {},
      ...options,
    };
  }

  get<T = unknown>(path: string, query?: HttpRequest["query"]): Promise<HttpResponse<T>> {
    return this.request<T>({ method: "GET", path, ...(query ? { query } : {}) });
  }

  post<T = unknown>(path: string, body: unknown, opts: { idempotent?: boolean } = {}): Promise<HttpResponse<T>> {
    return this.request<T>({ method: "POST", path, body, ...opts });
  }

  async request<T = unknown>(req: HttpRequest): Promise<HttpResponse<T>> {
    const idempotent = req.idempotent ?? req.method === "GET";
    let last: unknown;
    for (let attempt = 1; attempt <= this.o.maxAttempts; attempt++) {
      const outcome = await this.attempt(req);
      switch (outcome.kind) {
        case "ok":
          return outcome.res as HttpResponse<T>;
        case "fatal":
          throw outcome.err;
        case "throttled":
          last = outcome.err;
          if (attempt < this.o.maxAttempts) {
            this.o.log(`${this.o.name} 429 on ${req.method} ${req.path}; retry ${attempt} in ${outcome.waitMs} ms`);
            await this.o.sleep(outcome.waitMs);
          }
          break;
        case "unknown":
          if (!idempotent) throw new AmbiguousWriteError(this.o.name, req, outcome.err);
          last = outcome.err;
          if (attempt < this.o.maxAttempts) {
            const waitMs = this.backoff(attempt);
            this.o.log(`${this.o.name} ${describe(outcome.err)} on ${req.method} ${req.path}; retry ${attempt} in ${waitMs} ms`);
            await this.o.sleep(waitMs);
          }
          break;
      }
    }
    throw new RetriesExhaustedError(this.o.name, req, this.o.maxAttempts, last);
  }

  private async attempt(req: HttpRequest): Promise<Outcome> {
    let res: Response;
    try {
      res = await this.o.fetch(this.url(req), {
        method: req.method,
        headers: { ...this.o.headers, Accept: "application/json", ...(req.body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
        signal: AbortSignal.timeout(this.o.timeoutMs),
      });
    } catch (err) {
      return { kind: "unknown", err }; // timeout or connection drop: the server may have acted on it
    }

    const callLimit = res.headers.get("X-Shopify-Shop-Api-Call-Limit");
    if (callLimit) this.o.log(`${this.o.name} call limit ${callLimit}`);

    const body = await this.parseBody(res);
    const err = new HttpError(this.o.name, res.status, body, req);
    if (res.ok) return { kind: "ok", res: { status: res.status, headers: res.headers, body } };
    if (res.status === 429) return { kind: "throttled", waitMs: this.retryAfter(res.headers), err };
    if (res.status >= 500) return { kind: "unknown", err };
    return { kind: "fatal", err };
  }

  private url(req: HttpRequest): string {
    const url = new URL(req.path.replace(/^\//, ""), this.o.baseUrl.endsWith("/") ? this.o.baseUrl : `${this.o.baseUrl}/`);
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    return url.toString();
  }

  private async parseBody(res: Response): Promise<unknown> {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private retryAfter(headers: Headers): number {
    const seconds = Number(headers.get("Retry-After"));
    if (!Number.isFinite(seconds) || seconds < 0) return this.backoff(1);
    return Math.min(Math.ceil(seconds * 1000), this.o.maxDelayMs);
  }

  /** Exponential backoff with full jitter, capped. */
  private backoff(attempt: number): number {
    const ceiling = Math.min(this.o.maxDelayMs, this.o.baseDelayMs * 2 ** (attempt - 1));
    return Math.max(1, Math.round(this.o.random() * ceiling));
  }
}
