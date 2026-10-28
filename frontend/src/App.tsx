import { NavLink, Route, Routes } from "react-router-dom";
import { useSession } from "./state/session";
import TillPage from "./pages/TillPage";
import RefundsPage from "./pages/RefundsPage";
import DayEndPage from "./pages/DayEndPage";
import { Banner, ErrorBanner } from "./components/ui";

function SessionBar() {
  const s = useSession();
  return (
    <div className="session no-print">
      <select aria-label="Store" value={s.storeCode} onChange={(e) => s.setStoreCode(e.target.value)} disabled={!s.stores}>
        <option value="">{s.stores ? "Select store…" : "Loading stores…"}</option>
        {s.stores?.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
      </select>
      <select aria-label="Staff" value={s.staffId} onChange={(e) => s.setStaffId(e.target.value)} disabled={!s.storeCode || !s.staff}>
        <option value="">{!s.storeCode ? "Staff…" : s.staff ? "Select staff…" : "Loading staff…"}</option>
        {s.staff?.map((x) => <option key={x.staffId} value={x.staffId}>{x.name}{x.role === "store_manager" ? " (manager)" : ""}</option>)}
      </select>
    </div>
  );
}

export default function App() {
  const { error, reload, stores } = useSession();
  return (
    <>
      <header className="topbar no-print">
        <span className="brand">Eluno Till</span>
        <nav className="nav">
          <NavLink to="/" end>New sale</NavLink>
          <NavLink to="/refunds">Refunds</NavLink>
          <NavLink to="/day-end">Day-end</NavLink>
        </nav>
        <SessionBar />
      </header>
      {error && !stores && (
        <div className="page"><ErrorBanner error={error} title="Cannot load stores" actions={<button onClick={reload}>Retry</button>} /></div>
      )}
      {error && stores && <div className="page"><Banner tone="warn" title="Some reference data did not load" actions={<button onClick={reload}>Retry</button>}>{error.message}</Banner></div>}
      <main>
        <Routes>
          <Route path="/" element={<TillPage />} />
          <Route path="/refunds" element={<RefundsPage />} />
          <Route path="/day-end" element={<DayEndPage />} />
          <Route path="*" element={<div className="page"><Banner tone="info" title="Page not found" /></div>} />
        </Routes>
      </main>
    </>
  );
}
