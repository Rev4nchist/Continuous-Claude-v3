# Proposal: split the billing module

Today `billing/` is one module inside the monolith (invoices, payments, tax). 38k lines.

Proposal:
- Create three services: `invoice-svc`, `payment-svc`, `tax-svc`.
- All three keep reading and writing the same Postgres tables (`invoices`, `payments`,
  `tax_lines`) in the existing monolith database. No schema change.
- `invoice-svc` calls `tax-svc` and then `payment-svc` synchronously over HTTP for every invoice.
- One team (4 engineers) owns all three services.
- Reason: deploy billing changes without a full monolith release (today: one release a week).
