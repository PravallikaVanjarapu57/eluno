import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/endpoints";
import { ApiError } from "../api/client";
import { RxRecord } from "../components/RxParts";
import { Banner, Card, ErrorBanner, Pill, Spinner } from "../components/ui";
import { dateTime, money } from "../lib/format";
import { useLoad } from "../lib/useLoad";
import { useAuth } from "../state/auth";
import { useSession } from "../state/session";
import { billTone } from "../components/BillParts";

/** One customer: contact details, prescription history, recent bills, and the next things staff do (edit, add a prescription, start a sale). */
export default function CustomerProfilePage() {
  const { id = "" } = useParams();
  const { can } = useAuth();
  const { storeCode } = useSession();
  const nav = useNavigate();
  const notice = (useLocation().state as { notice?: string } | null)?.notice;
  const customer = useLoad(() => api.customerById(id), [id]);
  const rx = useLoad(() => api.prescriptions(id), [id]);
  const bills = useLoad(() => api.customerBills(id), [id]);

  if (customer.loading && !customer.data) return <div className="page"><Spinner label="Loading customer…" /></div>;
  if (customer.error) {
    const missing = customer.error instanceof ApiError && customer.error.status === 404;
    return (
      <div className="page">
        <Link to="/customers">← Customers</Link>
        {missing ? <Banner tone="warn" title="Customer not found">There is no customer with this id. They may have been removed in Shopify.</Banner>
          : <ErrorBanner error={customer.error} actions={<button onClick={customer.reload}>Retry</button>} />}
      </div>
    );
  }
  const view = customer.data!;
  const c = view.customer;
  const name = view.name || "(no name)";

  return (
    <div className="page">
      <Link to="/customers">← Customers</Link>
      <div className="between">
        <h1>{name}</h1>
        <div className="inline">
          {can("prescription:create") && <button onClick={() => nav(`/customers/${c.id}/prescriptions/new`)}>Add prescription</button>}
          {can("customer:update") && <button onClick={() => nav(`/customers/${c.id}/edit`)}>Edit customer</button>}
          {can("billing:use") && <button className="primary big" disabled={!storeCode} title={storeCode ? undefined : "Choose a store first"} onClick={() => nav(`/customers/${c.id}/sale`)}>Start sale</button>}
        </div>
      </div>
      {notice && <Banner tone="success">{notice}</Banner>}
      {can("billing:use") && !storeCode && <Banner tone="info" title="Choose a store">Select your store at the top of the screen to start a sale.</Banner>}

      <div className="grid-2">
        <Card title="Contact">
          <dl className="facts">
            <dt>Mobile</dt><dd className="mono">{c.phone}</dd>
            <dt>Email</dt><dd>{c.email ?? <span className="muted">Not recorded</span>}</dd>
            <dt>Orders</dt><dd>{c.ordersCount} · lifetime spend {money(c.lifetimeSpendPaise)}</dd>
          </dl>
          <div className="inline">
            {view.flags.priority && <Pill tone="warn">Priority customer</Pill>}
            {view.flags.family && <Pill tone="info">Family</Pill>}
            {view.flags.campaigns.map((x) => <Pill key={x} tone="info">Campaign: {x.replace(/_/g, " ")}</Pill>)}
          </div>
        </Card>

        <Card title="Recent bills">
          <ErrorBanner error={bills.error} actions={<button onClick={bills.reload}>Retry</button>} />
          {bills.loading && !bills.data && <Spinner />}
          {bills.data && bills.data.length === 0 && <div className="muted">No bills at your stores yet.</div>}
          {bills.data && bills.data.length > 0 && (
            <div className="scroll">
              <table aria-label="Recent bills">
                <thead><tr><th>Invoice</th><th>Date</th><th>Status</th><th className="num">Amount</th></tr></thead>
                <tbody>
                  {bills.data.map((b) => (
                    <tr key={b.invoiceNo}><td className="mono">{b.invoiceNo}</td><td>{dateTime(b.createdAt)}</td><td><Pill tone={billTone(b.status)}>{b.status.replace(/_/g, " ")}</Pill></td><td className="num">{money(b.payablePaise)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Card title={`Prescription history${rx.data ? ` (${rx.data.length})` : ""}`} actions={can("prescription:create") ? <button onClick={() => nav(`/customers/${c.id}/prescriptions/new`)}>Add prescription</button> : undefined}>
        <ErrorBanner error={rx.error} actions={<button onClick={rx.reload}>Retry</button>} />
        {rx.loading && !rx.data && <Spinner label="Loading prescriptions…" />}
        {rx.data && rx.data.length === 0 && <Banner tone="info" title="No prescription on file">Add the customer's prescription, or book an eye test. Frames and plain sunglasses can still be billed.</Banner>}
        <div className="stack">{rx.data?.map((v) => <RxRecord key={v.rx.rxId} view={v} />)}</div>
      </Card>
    </div>
  );
}
