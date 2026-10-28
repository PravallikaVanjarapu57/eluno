import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { api } from "../api/endpoints";
import type { CustomerRow } from "../api/types";
import { SummaryPill } from "../components/RxParts";
import { Banner, Card, ErrorBanner, Spinner } from "../components/ui";
import { useAuth } from "../state/auth";

const PAGE = 20;

/** Browse and search customers one page at a time. The search runs on the server; the browser never holds the whole customer list. */
export default function CustomersPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const notice = (useLocation().state as { notice?: string } | null)?.notice;
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "more" | "idle">("loading");
  const [error, setError] = useState<unknown>(null);
  const latest = useRef(0);

  // Wait for a pause in typing so each keystroke is not a request.
  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);

  const fetchPage = useCallback(async (q: string, cursor: string | null) => {
    const mine = ++latest.current;
    setState(cursor ? "more" : "loading");
    setError(null);
    try {
      const page = await api.customers({ q, cursor, limit: PAGE });
      if (mine !== latest.current) return; // a newer search has started: drop this answer
      setRows((old) => (cursor ? [...old, ...page.items] : page.items));
      setNext(page.nextCursor);
    } catch (e) {
      if (mine === latest.current) setError(e);
    } finally {
      if (mine === latest.current) setState("idle");
    }
  }, []);
  useEffect(() => { void fetchPage(query, null); }, [query, fetchPage]);

  return (
    <div className="page">
      <div className="between">
        <h1>Customers</h1>
        {can("customer:create") && <button className="primary big" onClick={() => nav("/customers/new")}>Add customer</button>}
      </div>
      {notice && <Banner tone="success">{notice}</Banner>}

      <Card>
        <form role="search" onSubmit={(e) => { e.preventDefault(); setQuery(text.trim()); }}>
          <label className="field">
            <span>Search customers</span>
            <input type="search" autoFocus placeholder="Name, mobile number or email" value={text} onChange={(e) => setText(e.target.value)} />
          </label>
        </form>

        <ErrorBanner error={error} actions={<button onClick={() => void fetchPage(query, null)}>Retry</button>} />
        {state === "loading" && <Spinner label="Loading customers…" />}

        {state !== "loading" && !error && rows.length === 0 && (
          query
            ? <Banner tone="info" title="No customers match">Nobody matches “{query}”. Check the spelling or try the last digits of the mobile number.{can("customer:create") && <> <Link to="/customers/new">Add a new customer</Link></>}</Banner>
            : <Banner tone="info" title="No customers yet">Customers you add will show up here.</Banner>
        )}

        {rows.length > 0 && (
          <div className="scroll">
            <table aria-label="Customers">
              <thead>
                <tr><th>Customer</th><th>Mobile</th><th>Email</th><th>Latest prescription</th><th className="num">Rx</th><th><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody>
                {rows.map(({ customer: c, prescriptions: rx }) => (
                  <tr key={c.id}>
                    <td><Link to={`/customers/${c.id}`}><b>{`${c.firstName} ${c.lastName}`.trim() || "(no name)"}</b></Link></td>
                    <td className="mono">{c.phone}</td>
                    <td className="email">{c.email ?? <span className="muted">—</span>}</td>
                    <td>
                      <SummaryPill summary={rx} />
                      {rx?.latest && <div className="small muted">Tested {rx.latest.testedOn}</div>}
                    </td>
                    <td className="num">{rx ? rx.count : "—"}</td>
                    <td>
                      <div className="inline row-actions">
                        <Link className="btn" to={`/customers/${c.id}`} aria-label={`View ${c.firstName} ${c.lastName}`}>View</Link>
                        {can("customer:update") && <Link className="btn" to={`/customers/${c.id}/edit`} aria-label={`Edit ${c.firstName} ${c.lastName}`}>Edit</Link>}
                        {can("billing:use") && <Link className="btn primary" to={`/customers/${c.id}/sale`} aria-label={`Start sale for ${c.firstName} ${c.lastName}`}>Start sale</Link>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {next && <button onClick={() => void fetchPage(query, next)} disabled={state === "more"}>{state === "more" ? "Loading…" : "Load more"}</button>}
        {rows.length > 0 && !next && state === "idle" && <div className="muted small">{rows.length} customer{rows.length === 1 ? "" : "s"} shown. That is everyone{query ? " who matches" : ""}.</div>}
      </Card>
    </div>
  );
}
