import { Glasses } from "lucide-react";
import { useState } from "react";
import { ApiError } from "../api/client";
import { Banner, ErrorBanner, Field } from "../components/ui";
import { useAuth } from "../state/auth";

export default function LoginPage() {
  const { login, notice } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
    } catch (e) {
      setError(e);
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="card login-card" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="brand login-brand"><span className="brand-mark"><Glasses size={20} aria-hidden /></span>Eluno <small>Till</small></div>
        <h1>Sign in</h1>
        {notice && <Banner tone="info">{notice}</Banner>}
        <Field label="Username" hint="Your staff ID, e.g. s105">
          <input autoFocus autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} />
        </Field>
        <Field label="Password">
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <ErrorBanner error={error} title={error instanceof ApiError && error.status === 429 ? "Too many attempts" : "Could not sign in"} />
        <button className="primary big" type="submit" disabled={busy || !username.trim() || !password}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </div>
  );
}
