// Pull ONE pinned file from a public Hugging Face dataset (decision doc 2026-11-02, section 3.2). Step A of the review-engine P0 eval.
// - Plain HTTPS GET with Node fetch. No token, no install, no loader code. The file is untrusted data: this script only stores it.
// - The dataset must be pinned to a 40-hex commit sha. A branch name or a missing sha is refused.
// - A HEAD request comes first. A file over 5 MB (or of unknown size) is refused; Dave must approve a bigger one.
// - Output: .claude/cache/hf-datasets/<id with / as __>@<sha>/<file> and manifest.json next to it. .claude/cache is gitignored.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_BYTES = 5 * 1024 * 1024;
const SHA_RE = /^[0-9a-f]{40}$/;
const ID_RE = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(HERE, '..', '..', '..', '.claude', 'cache', 'hf-datasets');

/** A refusal the CLI turns into exit 2. */
export class PullRefusal extends Error {}

export const datasetDirName = (id, sha) => `${id.replace('/', '__')}@${sha}`;
export const resolveUrl = (id, sha, file) => `https://huggingface.co/datasets/${id}/resolve/${sha}/${file.split('/').map(encodeURIComponent).join('/')}`;
export const treeUrl = (id, sha) => `https://huggingface.co/api/datasets/${id}/tree/${sha}`;

export function assertPinned({ id, sha, file }) {
  if (!ID_RE.test(String(id ?? ''))) throw new PullRefusal(`dataset id must look like owner/name, got ${JSON.stringify(id)}`);
  if (!SHA_RE.test(String(sha ?? ''))) throw new PullRefusal('a 40-hex commit sha is required (--sha). A branch name or no sha is refused: the pull must be pinned.');
  const f = String(file ?? '');
  if (f === '' || f.startsWith('/') || f.includes('\\') || f.split('/').some((p) => p === '..' || p === '')) throw new PullRefusal(`file must be a plain relative path, got ${JSON.stringify(file)}`);
}

/** The pinned dataset's file list, [{path, size}]. */
export async function listFiles({ id, sha }, { fetchFn = fetch } = {}) {
  assertPinned({ id, sha, file: 'x' });
  const res = await fetchFn(treeUrl(id, sha));
  if (!res.ok) throw new Error(`tree request failed: HTTP ${res.status}`);
  const rows = await res.json();
  return rows.filter((r) => r.type === 'file').map((r) => ({ path: r.path, size: r.size }));
}

/**
 * Pulls one file. Returns { dir, filePath, manifest }. Throws PullRefusal for an unpinned id or a file over maxBytes.
 * deps: { fetchFn, root, now }. Tests inject fetchFn and root; nothing else reaches the network.
 */
export async function pullPinned({ id, sha, file, maxBytes = MAX_BYTES }, { fetchFn = fetch, root = DEFAULT_ROOT, now = Date.now } = {}) {
  assertPinned({ id, sha, file });
  const url = resolveUrl(id, sha, file);
  const head = await fetchFn(url, { method: 'HEAD', redirect: 'follow' });
  if (!head.ok) throw new Error(`HEAD ${url} failed: HTTP ${head.status}`);
  const declared = Number(head.headers.get('content-length'));
  if (!Number.isFinite(declared) || declared <= 0) throw new PullRefusal(`no Content-Length for ${file}: size unknown, refusing. Dave must approve.`);
  if (declared > maxBytes) throw new PullRefusal(`${file} is ${declared} bytes, over the ${maxBytes} byte limit. Dave must approve a bigger file.`);

  const res = await fetchFn(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new PullRefusal(`${file} arrived as ${buf.length} bytes, over the ${maxBytes} byte limit.`); // HEAD lied

  const dir = path.join(root, datasetDirName(id, sha));
  const filePath = path.join(dir, ...file.split('/'));
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, buf);
  const manifest = { id, sha, file, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), fetchedAt: new Date(now()).toISOString() };
  writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir, filePath, manifest };
}

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--list') out.list = true;
    else if (a.startsWith('--') && i + 1 < argv.length) { out[a.slice(2)] = argv[i + 1]; i += 1; }
  }
  return out;
}

export async function main(argv, { stdout = (s) => console.log(s), stderr = (s) => console.error(s), fetchFn, root } = {}) {
  const f = parseFlags(argv);
  try {
    if (f.list) {
      for (const r of await listFiles(f, { fetchFn })) stdout(`${r.size}\t${r.path}`);
      return 0;
    }
    const { filePath, manifest } = await pullPinned(f, { fetchFn, root });
    stdout(`pulled ${manifest.id}@${manifest.sha} ${manifest.file}: ${manifest.bytes} bytes sha256 ${manifest.sha256}`);
    stdout(`stored ${filePath}`);
    return 0;
  } catch (e) {
    if (e instanceof PullRefusal) { stderr(`external-pull refused: ${e.message}`); return 2; }
    stderr(`external-pull failed: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
