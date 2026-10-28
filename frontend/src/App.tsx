import { NavLink, Route, Routes } from "react-router-dom";
import { useAuth } from "./state/auth";
import { SessionProvider, useSession } from "./state/session";
import LoginPage from "./pages/LoginPage";
import TillPage from "./pages/TillPage";
import CustomersPage from "./pages/CustomersPage";
import CustomerProfilePage from "./pages/CustomerProfilePage";
import { AddPrescriptionPage, EditCustomerPage, NewCustomerPage } from "./pages/CustomerFormPages";
import StartSalePage from "./pages/StartSalePage";
import RefundsPage from "./pages/RefundsPage";
import DayEndPage from "./pages/DayEndPage";
import { Banner, ErrorBanner, Pill, Spinner } from "./components/ui";

function UserBar() {
  const { user, logout } = useAuth();
  const s = useSession();
  if (!user) return null;
  return (
    <div className="session no-print">
      {s.stores && s.stores.length > 1 ? (
        <select aria-label="Store" value={s.storeCode} onChange={(e) => s.setStoreCode(e.target.value)}>
          <option value="">Select store…</option>
          {s.stores.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
        </select>
      ) : (
        <span className="who-store">{s.store?.name ?? (s.stores ? "No store assigned" : "Loading…")}</span>
      )}
      <span className="who">
        {user.name} <Pill tone={user.role === "store_manager" ? "info" : "neutral"}>{user.role === "store_manager" ? "Store manager" : "Salesperson"}</Pill>
      </span>
      <button onClick={() => void logout()}>Sign out</button>
    </div>
  );
}

function Shell() {
  const { can } = useAuth();
  const { error, reload, stores } = useSession();
  return (
    <>
      <header className="topbar no-print">
        <span className="brand">Eluno Till</span>
        <nav className="nav">
          <NavLink to="/" end>New sale</NavLink>
          {can("customer:view") && <NavLink to="/customers">Customers</NavLink>}
          <NavLink to="/refunds">Refunds</NavLink>
          {can("report:view") && <NavLink to="/day-end">Day-end</NavLink>}
        </nav>
        <UserBar />
      </header>
      {error && !stores && <div className="page"><ErrorBanner error={error} title="Cannot load stores" actions={<button onClick={reload}>Retry</button>} /></div>}
      {error && stores && <div className="page"><Banner tone="warn" title="Some reference data did not load" actions={<button onClick={reload}>Retry</button>}>{error.message}</Banner></div>}
      <main>
        <Routes>
          <Route path="/" element={<TillPage />} />
          {can("customer:view") && (
            <>
              <Route path="/customers" element={<CustomersPage />} />
              <Route path="/customers/new" element={<NewCustomerPage />} />
              <Route path="/customers/:id" element={<CustomerProfilePage />} />
              <Route path="/customers/:id/edit" element={<EditCustomerPage />} />
              <Route path="/customers/:id/prescriptions/new" element={<AddPrescriptionPage />} />
              <Route path="/customers/:id/sale" element={<StartSalePage />} />
            </>
          )}
          <Route path="/refunds" element={<RefundsPage />} />
          <Route path="/day-end" element={<DayEndPage />} />
          <Route path="*" element={<div className="page"><Banner tone="info" title="Page not found" /></div>} />
        </Routes>
      </main>
    </>
  );
}

export default function App() {
  const { status, user } = useAuth();
  if (status === "loading") return <div className="page"><Spinner label="Checking your session…" /></div>;
  if (status === "signedOut" || !user) return <LoginPage />;
  // Keyed by user so nothing from one person's session (store, half-built cart) carries over to the next.
  return (
    <SessionProvider key={user.username}>
      <Shell />
    </SessionProvider>
  );
}
