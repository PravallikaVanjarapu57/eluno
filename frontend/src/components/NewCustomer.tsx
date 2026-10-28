import type { CustomerLookup } from "../api/types";
import { CustomerForm } from "./CustomerForm";
import { Card } from "./ui";

/** The till's "new customer" step: the shared form in a card, then straight to the sale. */
export function NewCustomer({ initialPhone, onCreated, onCancel, onUseExisting }: {
  initialPhone: string;
  onCreated(c: CustomerLookup): void;
  onCancel(): void;
  onUseExisting(phone: string): void;
}) {
  return (
    <Card title="New customer">
      <CustomerForm mode="create" initialPhone={initialPhone} onSaved={onCreated} onCancel={onCancel} onUseExisting={onUseExisting} />
    </Card>
  );
}
