import { useRef, useState } from "react";
import { api } from "../api/endpoints";
import { ApiError } from "../api/client";
import type { Customer, CustomerLookup, CustomerView } from "../api/types";
import { Banner, ErrorBanner, Field } from "./ui";

// Same rules as the server (domain/customer.ts, domain/phone.ts); the server is still the judge and its messages win.
const PHONE = /^(?:\+?91|0)?[6-9]\d{9}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Fields = Partial<Record<"phone" | "firstName" | "lastName" | "email", string>>;

/** The messages the server attached to each field of a 4xx answer, if any. */
function serverFields(e: unknown): Fields {
  if (!(e instanceof ApiError)) return {};
  const f = (e.details as { fields?: Record<string, string> } | undefined)?.fields;
  return f && typeof f === "object" ? f : {};
}

type Props =
  | {
      mode: "create";
      initialPhone?: string;
      onSaved(c: CustomerLookup): void;
      onCancel(): void;
      onUseExisting(phone: string): void;
    }
  | {
      mode: "edit";
      customer: Customer;
      onSaved(c: CustomerView): void;
      onCancel(): void;
    };

/**
 * One form for adding and editing a customer. Creating goes through the till API (never Shopify directly) and hands back a
 * customer who can be billed at once. Editing changes name and email only: the phone is what prescriptions and bills are found by.
 */
export function CustomerForm(props: Props) {
  const editing = props.mode === "edit";
  const start = editing ? props.customer : null;
  const [phone, setPhone] = useState(editing ? props.customer.phone : (props.initialPhone ?? ""));
  const [firstName, setFirstName] = useState(start?.firstName ?? "");
  const [lastName, setLastName] = useState(start?.lastName ?? "");
  const [email, setEmail] = useState(start?.email ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [touched, setTouched] = useState(false);
  const [checking, setChecking] = useState(false);
  const [notCreated, setNotCreated] = useState(false);
  const inflight = useRef(false);

  const local: Fields = {};
  if (!editing && !PHONE.test(phone.replace(/[\s\-()]/g, ""))) local.phone = phone ? "Enter a 10-digit Indian mobile number." : "Mobile number is required.";
  if (!firstName.trim()) local.firstName = "First name is required.";
  if (email.trim() && !EMAIL.test(email.trim())) local.email = "That does not look like an email address.";
  const valid = Object.keys(local).length === 0;
  const fromServer = serverFields(error);
  const shown = (k: keyof Fields) => (touched ? local[k] : undefined) ?? fromServer[k];
  const e = error instanceof ApiError ? error : null;

  async function submit() {
    setTouched(true);
    if (inflight.current || !valid) return; // one request per click; a double tap cannot save twice
    inflight.current = true;
    setBusy(true);
    setError(null);
    setNotCreated(false);
    try {
      if (props.mode === "edit") {
        props.onSaved(await api.updateCustomer(props.customer.id, { firstName: firstName.trim(), lastName: lastName.trim(), email: email.trim() || null }));
      } else {
        props.onSaved(await api.createCustomer({ phone: phone.trim(), firstName: firstName.trim(), ...(lastName.trim() ? { lastName: lastName.trim() } : {}), ...(email.trim() ? { email: email.trim() } : {}) }));
      }
    } catch (err) {
      setError(err);
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }

  /** After a lost answer: ask the server whether the customer exists. A read, so always safe. */
  async function check() {
    if (props.mode !== "create") return;
    setChecking(true);
    try {
      props.onSaved(await api.customer(phone.trim()));
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
    <form className="stack" noValidate onSubmit={(ev) => { ev.preventDefault(); void submit(); }}>
      <div className="fields">
        <Field label={editing ? "Mobile number" : "Mobile number *"} hint={editing ? "Cannot be changed here: prescriptions and bills are found by it." : "10 digits, e.g. 9000012345"} error={shown("phone")}>
          <input inputMode="tel" value={phone} readOnly={editing} onChange={(ev) => setPhone(ev.target.value)} aria-invalid={!!shown("phone")} />
        </Field>
        <Field label="First name *" error={shown("firstName")}>
          <input autoFocus value={firstName} maxLength={60} onChange={(ev) => setFirstName(ev.target.value)} aria-invalid={!!shown("firstName")} />
        </Field>
        <Field label="Last name" error={shown("lastName")}>
          <input value={lastName} maxLength={60} onChange={(ev) => setLastName(ev.target.value)} />
        </Field>
        <Field label="Email (optional)" error={shown("email")}>
          <input type="email" inputMode="email" value={email} onChange={(ev) => setEmail(ev.target.value)} aria-invalid={!!shown("email")} />
        </Field>
      </div>

      {props.mode === "create" && e?.code === "CUSTOMER_EXISTS" ? (
        <Banner tone="warn" title="This customer already exists" actions={<button className="primary" type="button" onClick={() => props.onUseExisting(phone.trim())}>Open existing customer</button>}>{e.message}</Banner>
      ) : props.mode === "create" && e?.outcomeUnknown ? (
        <Banner tone="warn" title="Could not confirm the customer was created" actions={<button className="primary" type="button" onClick={check} disabled={checking}>{checking ? "Checking…" : "Check whether they exist"}</button>}>
          {e.message} <b>Check before trying again</b>: they may already have been created.
        </Banner>
      ) : e && e.code === "CUSTOMER_EXISTS" ? (
        <Banner tone="warn" title="Email already in use">{e.message}</Banner>
      ) : (
        <ErrorBanner error={error} />
      )}
      {notCreated && <Banner tone="info" title="Not created">Shopify has no customer with this number, so nothing was saved. You can create them again.</Banner>}

      <div className="inline">
        <button className="primary big" type="submit" disabled={busy}>{busy ? "Saving…" : editing ? "Save changes" : "Create customer"}</button>
        <button type="button" onClick={props.onCancel}>Cancel</button>
      </div>
    </form>
  );
}
