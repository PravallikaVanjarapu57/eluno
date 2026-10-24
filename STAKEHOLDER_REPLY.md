**Re: [Retail-Requirement] Replace Shopify POS in stores — live by 15 Nov**
**To:** Rohan · **Cc:** Priya, Meena, Dr. Iyer, Vikram, Farhan

Hi all. Here's the scoped v1, the decisions I need from you this week, and what I'm not doing. In short: almost
everything fits v1. Five items conflict or belong outside the till. The biggest risk is switching all 7 stores in
the week after Diwali (8 Nov), so I propose a pilot first.

### 1. What v1 does

Shopify stays the backend. Every bill, payment, refund and restock shows up in Shopify admin as today.

| Asked by | v1 |
|---|---|
| Rohan | Priority and campaign customers flagged at billing, from the same customer tags the queue tool uses. |
| Rohan, Meena | Offers apply automatically from one rules list. Staff never type a discount, and the screen shows why each offer did or didn't apply. |
| Meena, Vikram | Manager discount up to 10%: one tap by the store manager (who is the approver) plus a reason code. |
| Dr. Iyer | A lens outside the prescription's range can't be billed. Staff see which eye and value, and which index would work. Progressive/bifocal need an ADD. Expired prescriptions are blocked. |
| Vikram | GST per line by HSN, correct to the paisa. Rates carry effective dates, so a rate change never forces re-issuing invoices. |
| Vikram | Per-store invoice numbers with no gaps; a cancelled bill keeps its number. Refunds get a credit note naming the invoice and reversing its tax line by line. |
| Farhan | On refund, the frame goes back to the stock of the store that billed it; the lens is not restocked. |
| Farhan | Wi-Fi drop: the bill is saved at every step and continues when the connection returns. It's never lost and never created twice. |
| Vikram, Meena | Day-end per store, from Shopify: bills, tax, discounts and refunds, split by payment method and by channel. Any mismatch with the till is listed by invoice number. |
| Meena, Vikram | Cash drawer: float, paid-outs and paid-ins with a reason, count at close; variance over ₹200 sent to Vikram that night. |

**Built in this exercise:** every row except the cash drawer, which is next.

**After launch, and why:**
- **Family billing on one bill:** Shopify allows one customer per order, and the store tool doesn't link family members yet. About two weeks after go-live.
- **Remakes:** a zero-value lens order linked to the original invoice, no frame line. It needs a rule for who pays the lab, so remakes stay on today's process until then.
- **Partial refunds:** soon after launch.
- **Rohan's 10 am email:** the week after go-live, built on the day-end report.

### 2. Conflicts, risks, and things outside the till

1. **"All offers stack" (Meena) vs the rules as written.** Festive 10% is set as *not combinable*, so it won't
   stack with second-pair and priority. The till gives the customer the best allowed combination. Whether
   Festive should stack is a margin call for **Meena and Vikram together**. Either way it's a data change, not code.
2. **"No approval chain" (Meena) vs "approver + reason code" (Vikram).** Resolved by making the store manager
   the approver: one tap. Vikram, please confirm auditors accept this.
3. **"10 seconds" vs compliance (Rohan).** Tax and offers are worked out while the customer decides. After
   "yes", the till only charges and saves, and Shopify updates in the background if it's slow. Customers paying
   by UPI/card is the part I can't speed up.
4. **All 7 stores by 15 Nov, in Diwali week.** Proposal:
   - Pilot at Koramangala (the Wi-Fi problem store) from 1 Nov.
   - Roll out to the other six once five pilot day-ends match Shopify.
   - Keep Shopify POS installed as a fallback until 30 Nov.
5. **Not the till.**
   - The beverage question goes to the queue-tool backlog.
   - The Indiranagar footfall camera is an Ops/vendor ticket.
   - The 5° axis picker belongs in the store tool, where prescriptions are entered; I'll raise it there. The till still warns on off-grid axes.

### 3. Questions (answers by Friday keep the build unblocked)

| To | Question | Why it matters for v1 |
|---|---|---|
| Rohan | Is "10 seconds" from "yes" to printed bill, excluding the customer paying? OK to pilot Koramangala first? | What we measure; launch plan. |
| Meena | Who owns the offer list and signs off new offers? Who marks a bill WhatsApp-booked: staff, or the queue tool? | Offers are now data anyone can edit; the channel report is only as good as that field. |
| Meena | Until family billing ships: three bills settled in one payment. Acceptable? | Whether it blocks launch. |
| Vikram | Is my draft list of discount/refund reason codes right? Can any staff member refund, or only managers? | Auditors check both. |
| Vikram | Can a flat discount (₹500 priority) be split across frame (18%) and lens (5%) by price? Old bills put it all on the frame. | It changes the GST on every discounted bill. |
| Vikram | Do prefixes like `ELU/HSR/FY26/` reset on 1 April? Do any bills need e-invoicing (IRN)? | The series must continue cleanly from Shopify POS. |
| Dr. Iyer | Expired prescription: hard block, or optometrist override with a reason? An external prescription with an off-grid axis (e.g. 87°): re-test or confirm? | Decides whether the lens can be billed. |
| Farhan | Frame out of stock at this store: sell and transfer from another store, or never? | Today the till blocks it. |
| Dr. Iyer, Farhan, Vikram | Who bears a remake's lab cost, and who decides? | Blocks the remake flow. |

### 4. What I need to ship for real

- **Shopify:** a production app (orders, customers, inventory, locations), a test store, and order webhooks.
- **Store tool team:** an authenticated API for prescriptions and staff rosters.
- **Payments:** Razorpay terminal credentials, a test device per store, and confirmation of how refunds behave on retry.
- **Vikram:**
  - reason codes and sign-off on the invoice format
  - GSTIN per store
  - the last Shopify POS invoice number per store at cutover
  - the cash float per store
- **Meena:** a 30-minute training in each store, and one person on call during the pilot.
- **Farhan:** a 4G backup router at Koramangala, and a printer check in every store.

A working version runs against test copies of Shopify, the store tool and the terminal. I can demo it in 15
minutes this week.

Pravallika Vanjarapu

