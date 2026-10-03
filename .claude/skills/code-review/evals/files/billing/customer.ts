import { db } from "../db";
import { formatInvoiceNumber, Invoice } from "./invoice";

export interface Customer {
  id: string;
  name: string;
  region: string;
}

export async function getCustomer(id: string): Promise<Customer> {
  const rows: Customer[] = await db.query(`SELECT id, name, region FROM customers WHERE id = '${id}'`);
  if (rows.length === 0) throw new Error(`customer ${id} not found`);
  return rows[0];
}

export function statementLine(customer: Customer, inv: Invoice): string {
  return `${customer.name}: ${formatInvoiceNumber(inv)}`;
}
