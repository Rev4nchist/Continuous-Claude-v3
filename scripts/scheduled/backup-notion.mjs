/**
 * Notion client of the nightly state backup (card ops-state-backup-nightly). Node fetch only; no ntn CLI.
 * Design: .claudedocs/e2e-ops-state-backup-nightly/00-design-note.md sections 4, 5 and 7. A module only: no shebang, no argv read.
 *
 *   makeNotion({ base, token, version, parent, queryPath, fetchImpl })   -> { call, createRow }
 *   uploadFile(client, { filename, contentType, size, readSlice, maxBytes })   single or multi-part upload, returns { id, mode }
 *   rowProperties(manifest, { status, drill, drillDetail })   the page properties of one night (a failed night too)
 *   listRows(client)                                          every row, read back as retention rows
 *   runRetention(client, rows, { now, allowTrash })           trash what chooseRetention names, only when allowed
 *
 * The token goes in one header and nowhere else. Every error text passes through maskText with the token as a secret.
 */
import { TASK, chooseRetention, maskText, planUpload } from './backup-state-lib.mjs';

export const NOTION_VERSION = '2026-03-11';

/** An error from Notion or from a refusal before the call. code: 'empty' | 'over-limit' | 'http'. */
export class BackupNotionError extends Error {
  constructor(message, { code = 'http', status } = {}) {
    super(message);
    this.name = 'BackupNotionError';
    this.code = code;
    this.status = status;
  }
}

export function makeNotion({ base = 'https://api.notion.com', token, version = NOTION_VERSION, parent, queryPath, fetchImpl = fetch } = {}) {
  if (!token) throw new BackupNotionError('no Notion token', { code: 'no-token' });
  const secrets = [token];
  async function call(method, path, { json, form } = {}) {
    const headers = { Authorization: `Bearer ${token}`, 'Notion-Version': version };
    let body;
    if (form) body = form;
    else if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, { method, headers, body });
    } catch (e) {
      throw new BackupNotionError(maskText(`${method} ${path} failed: ${e.message}`, { secrets }), { code: 'network' });
    }
    const text = await res.text();
    if (!res.ok) throw new BackupNotionError(maskText(`${method} ${path} -> ${res.status}: ${text}`, { secrets }), { status: res.status });
    return text ? JSON.parse(text) : {};
  }
  return {
    call,
    parent,
    queryPath,
    createRow: (properties) => call('POST', '/v1/pages', { json: { parent, properties } }),
  };
}

/** Send a file to Notion and return its upload id. Refuses an empty file and a file over maxBytes before any request. */
export async function uploadFile(client, { filename, contentType, size, readSlice, maxBytes }) {
  const plan = planUpload(size, { maxBytes });
  if (plan.error) throw new BackupNotionError(`${filename}: ${plan.error}`, { code: plan.error });
  const multi = plan.mode === 'multi';
  const created = await client.call('POST', '/v1/file_uploads', {
    json: multi
      ? { mode: 'multi_part', number_of_parts: plan.parts.length, filename, content_type: contentType }
      : { filename, content_type: contentType },
  });
  const id = created.id;
  const send = (bytes, partNumber) => {
    const form = new FormData();
    if (partNumber) form.set('part_number', String(partNumber));
    form.set('file', new Blob([bytes], { type: contentType }), filename);
    return client.call('POST', `/v1/file_uploads/${id}/send`, { form });
  };
  if (!multi) {
    await send(readSlice(0, size));
    return { id, mode: 'single' };
  }
  for (const part of plan.parts) await send(readSlice(part.start, part.end), part.n);
  await client.call('POST', `/v1/file_uploads/${id}/complete`, { json: {} });
  return { id, mode: 'multi' };
}

const text = (content) => ({ rich_text: [{ type: 'text', text: { content } }] });
const select = (name) => ({ select: { name } });

/** Page properties of one night. manifest: { date, kind, files: [{ name, bytes, sha256, uploadId }] }. */
export function rowProperties(manifest, { status, drill, drillDetail = '' }) {
  const sizes = manifest.files.map((f) => `${f.name} ${f.bytes} B ${f.sha256}`).join('\n');
  return {
    Name: { title: [{ type: 'text', text: { content: manifest.date } }] },
    Date: { date: { start: manifest.date } },
    Kind: select(manifest.kind),
    Status: select(status),
    Files: { files: manifest.files.filter((f) => f.uploadId).map((f) => ({ type: 'file_upload', name: f.name, file_upload: { id: f.uploadId } })) },
    'Sizes and sha256': text(sizes),
    Drill: select(drill),
    'Drill detail': text(maskText(drillDetail, { secrets: [] })),
    Task: text(TASK),
  };
}

const plain = (prop) => (prop?.rich_text ?? []).map((t) => t.plain_text ?? t.text?.content ?? '').join('');

/** All rows of the backup database, as { id, date, kind, status, drill, task }. Follows the cursor. */
export async function listRows(client) {
  const rows = [];
  let cursor;
  for (;;) {
    const page = await client.call('POST', client.queryPath, { json: cursor ? { page_size: 100, start_cursor: cursor } : { page_size: 100 } });
    for (const r of page.results ?? []) {
      const p = r.properties ?? {};
      rows.push({
        id: r.id,
        date: p.Date?.date?.start ?? null,
        kind: p.Kind?.select?.name ?? null,
        status: p.Status?.select?.name ?? null,
        drill: p.Drill?.select?.name ?? null,
        task: plain(p.Task),
      });
    }
    if (!page.has_more) return rows;
    cursor = page.next_cursor;
  }
}

/** Apply chooseRetention. allowTrash false only names the rows (wouldTrash). Returns { trashed, wouldTrash }. */
export async function runRetention(client, rows, { now, allowTrash }) {
  const { trash } = chooseRetention(rows, { now });
  if (!allowTrash) return { trashed: [], wouldTrash: trash };
  const trashed = [];
  for (const id of trash) {
    await client.call('PATCH', `/v1/pages/${id}`, { json: { in_trash: true } });
    trashed.push(id);
  }
  return { trashed, wouldTrash: trash };
}
