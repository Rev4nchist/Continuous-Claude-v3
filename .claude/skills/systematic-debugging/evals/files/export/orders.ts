import { db } from "../db";
import { writeCsv } from "./csv";

const PAGE_SIZE = 1000;

// Streams every order into orders.csv, one page at a time.
export async function exportOrders(path: string) {
  let cursor = new Date(0);
  const out = [];
  for (;;) {
    const { rows } = await db.query(
      `SELECT id, user_id, total_cents, placed_at
         FROM orders
        WHERE placed_at > $1
        ORDER BY placed_at
        LIMIT $2`,
      [cursor, PAGE_SIZE]
    );
    if (rows.length === 0) break;
    out.push(...rows);
    cursor = rows[rows.length - 1].placed_at;
  }
  await writeCsv(path, out);
  return out.length;
}
