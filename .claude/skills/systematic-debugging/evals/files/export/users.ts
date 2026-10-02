import { db } from "../db";
import { writeCsv } from "./csv";

const PAGE_SIZE = 500;

// Streams every live user into users.csv, one page at a time.
export async function exportUsers(path: string) {
  let cursor = new Date(0);
  const out = [];
  for (;;) {
    const { rows } = await db.query(
      `SELECT id, email, created_at
         FROM users
        WHERE deleted_at IS NULL
          AND created_at > $1
        ORDER BY created_at
        LIMIT $2`,
      [cursor, PAGE_SIZE]
    );
    if (rows.length === 0) break;
    out.push(...rows);
    cursor = rows[rows.length - 1].created_at;
  }
  await writeCsv(path, out);
  return out.length;
}
