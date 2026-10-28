// The one place the browser talks to the till API (same origin, under /api). It never calls Shopify, the
// store tool or the terminal: those are reached only by the till server.
//
// Retry policy (browser side):
//   GET                -> retried on network errors, 429, 502 and 503 (reads change nothing).
//   POST/PUT/DELETE    -> NEVER retried here. The server already retries upstream calls safely and keeps charges and
//                         refunds idempotent; a repeat from the browser has to be a deliberate staff action
//                         (Resume / Check status), so a double click can never become a second charge.

export class ApiError extends Error {
  constructor(
    readonly status: number, // 0 = the server could not be reached
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
  /** The write may or may not have reached the server, or the server could not say how it ended. */
  get outcomeUnknown(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

export interface ApiResult<T> {
  status: number;
  data: T;
}

const BASE = "/api";
const RETRY_STATUS = new Set([429, 502, 503]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RequestOptions {
  body?: unknown;
  /** Statuses (besides 2xx) that carry a normal domain payload, e.g. 402 for a declined payment. */
  accept?: number[];
  retries?: number;
  signal?: AbortSignal;
}

export async function request<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, opts: RequestOptions = {}): Promise<ApiResult<T>> {
  const maxAttempts = method === "GET" ? 1 + (opts.retries ?? 3) : 1;
  let last: ApiError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) await sleep(Math.min(4000, 400 * 2 ** (attempt - 2)) + Math.random() * 200);
    try {
      const res = await fetch(BASE + path, {
        method,
        headers: opts.body !== undefined ? { "Content-Type": "application/json", Accept: "application/json" } : { Accept: "application/json" },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* non-JSON body (e.g. a proxy error page) */
      }
      if (res.ok || opts.accept?.includes(res.status)) return { status: res.status, data: json as T };
      const b = (json ?? {}) as { code?: string; message?: string; details?: unknown };
      last = new ApiError(
        res.status,
        b.code ?? `HTTP_${res.status}`,
        b.message ?? (res.status >= 500 ? "The till server had a problem. Check the connection and try again." : `Request failed (${res.status}).`),
        b.details,
      );
      if (!RETRY_STATUS.has(res.status)) throw last;
    } catch (e) {
      if (e instanceof ApiError) {
        last = e;
        if (!RETRY_STATUS.has(e.status)) throw e;
      } else if ((e as Error).name === "AbortError") {
        throw e;
      } else {
        last = new ApiError(0, "NETWORK", "Could not reach the till server. Check the Wi-Fi connection.");
      }
    }
  }
  throw last ?? new ApiError(0, "NETWORK", "Could not reach the till server.");
}

export const get = <T>(path: string, opts?: RequestOptions) => request<T>("GET", path, opts).then((r) => r.data);

/** Invoice and credit-note numbers contain slashes (ELU/HSR/FY26/00003). */
export const enc = encodeURIComponent;
