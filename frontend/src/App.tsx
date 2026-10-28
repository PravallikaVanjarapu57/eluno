import { NavLink, Route, Routes } from "react-router-dom";
import { BarChart3, Glasses, LogOut, MapPin, ShoppingBag, Undo2, Users } from "lucide-react";
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
import { Banner, ErrorBanner, Pill, Spinner, ToastProvider } from "./components/ui";

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
        <span className="who-store"><MapPin size={15} className="icon" aria-hidden />{s.store?.name ?? (s.stores ? "No store assigned" : "Loading…")}</span>
      )}
      <span className="who">
        {user.name} <Pill tone={user.role === "store_manager" ? "info" : "neutral"}>{user.role === "store_manager" ? "Store manager" : "Salesperson"}</Pill>
      </span>
      <button className="ghost" onClick={() => void logout()}><LogOut size={16} className="icon" aria-hidden />Sign out</button>
    </div>
  );
}

function Shell() {
  const { can } = useAuth();
  const { error, reload, stores } = useSession();
  return (
    <>
      <header className="topbar no-print">
        <span className="brand"><span className="brand-mark"><Glasses size={20} aria-hidden /></span>Eluno <small>Till</small></span>
        <nav className="nav">
          <NavLink to="/" end><ShoppingBag size={18} className="icon" aria-hidden /><span className="label">New sale</span></NavLink>
          {can("customer:view") && <NavLink to="/customers"><Users size={18} className="icon" aria-hidden /><span className="label">Customers</span></NavLink>}
          <NavLink to="/refunds"><Undo2 size={18} className="icon" aria-hidden /><span className="label">Refunds</span></NavLink>
          {can("report:view") && <NavLink to="/day-end"><BarChart3 size={18} className="icon" aria-hidden /><span className="label">Day-end</span></NavLink>}
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
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </SessionProvider>
  );
}
