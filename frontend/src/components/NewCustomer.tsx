import { useRef, useState } from "react";
import { api } from "../api/endpoints";
import { ApiError } from "../api/client";
import type { CustomerLookup } from "../api/types";
import { Banner, Card, ErrorBanner, Field } from "./ui";

// Same rule as the server's phone normaliser; the server is still the judge.
const PHONE = /^(?:\+?91|0)?[6-9]\d{9}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Create a billing customer through the till API (never Shopify directly), then hand them straight to the sale. */
export function NewCustomer({ initialPhone, onCreated, onCancel, onUseExisting }: {
  initialPhone: string;
  onCreated(c: CustomerLookup): void;
  onCancel(): void;
  onUseExisting(phone: string): void;
}) {
  const [phone, setPhone] = useState(initialPhone);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [checking, setChecking] = useState(false);
  const [notCreated, setNotCreated] = useState(false);
  const inflight = useRef(false);

  const phoneOk = PHONE.test(phone.replace(/[\s\-()]/g, ""));
  const emailOk = !email.trim() || EMAIL.test(email.trim());
  const valid = phoneOk && firstName.trim().length > 0 && emailOk;
  const e = error instanceof ApiError ? error : null;

  async function submit() {
    if (inflight.current || !valid) return; // one request per click; a double tap cannot create twice
    inflight.current = true;
    setBusy(true);
    setError(null);
    setNotCreated(false);
    try {
      onCreated(await api.createCustomer({ phone: phone.trim(), firstName: firstName.trim(), ...(lastName.trim() ? { lastName: lastName.trim() } : {}), ...(email.trim() ? { email: email.trim() } : {}) }));
    } catch (err) {
      setError(err);
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }

  /** After a lost answer: ask the server whether the customer exists. A read, so always safe. */
  async function check() {
    setChecking(true);
    try {
      onCreated(await api.customer(phone.trim()));
    } catch (err) {
      if (err instanceof ApiError && err.code === "CUSTOMER_NOT_FOUND") {
        setNotCreated(true);
        setError(null);
      } else setError(err);
    } finally {
      setChecking(false);
    }
  }

  return (
    <Card title="New customer" actions={<button className="link" onClick={onCancel}>Cancel</button>}>
      <form className="stack" onSubmit={(ev) => { ev.preventDefault(); void submit(); }}>
        <div className="fields">
          <Field label="Mobile number *" hint={phone && !phoneOk ? "Enter a 10-digit Indian mobile number" : "10 digits, e.g. 9000012345"}>
            <input inputMode="tel" value={phone} onChange={(ev) => setPhone(ev.target.value)} aria-invalid={!!phone && !phoneOk} />
          </Field>
          <Field label="First name *"><input autoFocus value={firstName} maxLength={60} onChange={(ev) => setFirstName(ev.target.value)} /></Field>
          <Field label="Last name"><input value={lastName} maxLength={60} onChange={(ev) => setLastName(ev.target.value)} /></Field>
          <Field label="Email (optional)" hint={email && !emailOk ? "That does not look like an email address" : undefined}>
            <input type="email" inputMode="email" value={email} onChange={(ev) => setEmail(ev.target.value)} aria-invalid={!emailOk} />
          </Field>
        </div>

        {e?.code === "CUSTOMER_EXISTS" ? (
          <Banner tone="warn" title="This customer already exists" actions={<button className="primary" onClick={() => onUseExisting(phone.trim())} type="button">Use existing customer</button>}>{e.message}</Banner>
        ) : e?.outcomeUnknown ? (
          <Banner tone="warn" title="Could not confirm the customer was created"
            actions={<button className="primary" type="button" onClick={check} disabled={checking}>{checking ? "Checking…" : "Check whether they exist"}</button>}>
            {e.message} <b>Check before trying again</b>: they may already have been created.
          </Banner>
        ) : (
          <ErrorBanner error={error} />
        )}
        {notCreated && <Banner tone="info" title="Not created">Shopify has no customer with this number, so nothing was saved. You can create them again.</Banner>}

        <button className="primary big" type="submit" disabled={!valid || busy}>{busy ? "Creating…" : "Create customer"}</button>
      </form>
    </Card>
  );
}
