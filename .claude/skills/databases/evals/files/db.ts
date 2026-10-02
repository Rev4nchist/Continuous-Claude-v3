import { Pool } from "pg";

// Shared pool for the dashboard API. Box: 8 cores, one NVMe disk.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 100,
});

export async function getDashboard(userId: string) {
  const client = await pool.connect();
  const projects = await client.query(
    "SELECT * FROM projects WHERE owner_id = '" + userId + "'"
  );
  const result = [];
  for (const p of projects.rows) {
    const sessions = await client.query(
      "SELECT * FROM sessions WHERE project_id = $1",
      [p.id]
    );
    result.push({ ...p, sessions: sessions.rows });
  }
  client.release();
  return result;
}
