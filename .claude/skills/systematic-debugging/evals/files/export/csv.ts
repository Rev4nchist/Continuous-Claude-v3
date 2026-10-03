import { createWriteStream } from "node:fs";

function cell(v: unknown): string {
  const s = v instanceof Date ? v.toISOString() : String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function writeCsv(path: string, rows: Record<string, unknown>[]) {
  const ws = createWriteStream(path);
  if (rows.length) ws.write(Object.keys(rows[0]).join(",") + "\n");
  for (const r of rows) ws.write(Object.values(r).map(cell).join(",") + "\n");
  await new Promise<void>((res, rej) => ws.end((e?: Error) => (e ? rej(e) : res())));
}
