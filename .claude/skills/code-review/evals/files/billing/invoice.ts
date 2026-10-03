import { db } from "../db";
import { getCustomer, Customer } from "./customer";

export interface Invoice {
  id: string;
  customerId: string;
  netCents: number;
}

export function totalWithTax(inv: Invoice, customer: Customer): number {
  const rate = customer.region === "CA" ? 0.0725 : 0;
  return Math.round(inv.netCents * (1 + rate));
}

export async function openInvoices(accountId: string): Promise<Array<Invoice & { totalCents: number }>> {
  const invoices: Invoice[] = await db.query(
    "SELECT id, customer_id AS \"customerId\", net_cents AS \"netCents\" FROM invoices WHERE account_id = $1 AND status = 'open'",
    [accountId],
  );
  const out = [];
  for (const inv of invoices) {
    const customer = await getCustomer(inv.customerId);
    out.push({ ...inv, totalCents: totalWithTax(inv, customer) });
  }
  return out;
}

export function formatInvoiceNumber(inv: Invoice): string {
  return `INV-${inv.id.padStart(8, "0")}`;
}
