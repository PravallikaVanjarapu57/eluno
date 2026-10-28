import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api/endpoints";
import { ApiError } from "../api/client";
import { CustomerForm } from "../components/CustomerForm";
import { PrescriptionForm } from "../components/PrescriptionForm";
import { Banner, Card, ErrorBanner, Spinner } from "../components/ui";
import { useLoad } from "../lib/useLoad";

export function NewCustomerPage() {
  const nav = useNavigate();
  return (
    <div className="page">
      <Link to="/customers">← Customers</Link>
      <h1>Add customer</h1>
      <Card>
        <CustomerForm
          mode="create"
          onCancel={() => nav("/customers")}
          onUseExisting={(phone) => void api.customer(phone).then((l) => nav(`/customers/${l.customer.id}`)).catch(() => nav("/customers"))}
          onSaved={(l) => nav(`/customers/${l.customer.id}`, { state: { notice: `${l.customer.firstName} ${l.customer.lastName}`.trim() + " was added." } })}
        />
      </Card>
    </div>
  );
}

export function EditCustomerPage() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const { data, error, loading, reload } = useLoad(() => api.customerById(id), [id]);
  return (
    <div className="page">
      <Link to={`/customers/${id}`}>← Back to customer</Link>
      <h1>Edit customer</h1>
      {loading && !data && <Spinner />}
      {error instanceof ApiError && error.status === 404 ? <Banner tone="warn" title="Customer not found" /> : <ErrorBanner error={error} actions={<button onClick={reload}>Retry</button>} />}
      {data && (
        <Card>
          <CustomerForm mode="edit" customer={data.customer} onCancel={() => nav(`/customers/${id}`)} onSaved={(v) => nav(`/customers/${id}`, { state: { notice: `Saved changes to ${v.name}.` } })} />
        </Card>
      )}
    </div>
  );
}

/** Add a prescription. With ?returnTo=sale the customer lands back on their sale (same cart) afterwards. */
export function AddPrescriptionPage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const fromSale = params.get("returnTo") === "sale";
  const { data, error, loading, reload } = useLoad(() => api.customerById(id), [id]);
  const back = fromSale ? `/customers/${id}/sale` : `/customers/${id}`;
  return (
    <div className="page">
      <Link to={back}>← {fromSale ? "Back to the sale" : "Back to customer"}</Link>
      <h1>Add prescription{data ? ` · ${data.name}` : ""}</h1>
      {loading && !data && <Spinner />}
      {error instanceof ApiError && error.status === 404 ? <Banner tone="warn" title="Customer not found" /> : <ErrorBanner error={error} actions={<button onClick={reload}>Retry</button>} />}
      {data && (
        <PrescriptionForm
          customerId={id}
          customerName={data.name}
          onCancel={() => nav(back)}
          onSaved={(v) => nav(back, { state: { notice: `Prescription ${v.rx.rxId} saved${v.status === "valid" ? "." : ` (${v.status === "expired" ? "already expired" : "future-dated"}, kept as history).`}` } })}
        />
      )}
    </div>
  );
}
