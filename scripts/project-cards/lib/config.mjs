// config.mjs — single source of truth for the living project-card engine.
// Every id, path, and section-heading string previously copy-pasted across
// refresh.mjs / sweep.mjs / lib/notion.mjs lives here. ESM, no deps.
//
// Paths resolve relative to the project-cards ROOT (the parent of lib/), so they
// are correct no matter which cwd the entry scripts are invoked from.
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// lib/ -> project-cards ROOT
export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// --- filesystem paths ---
export const LIB_DIR = join(ROOT, 'lib');
export const OUT_DIR = join(ROOT, 'out');
export const LOGS_DIR = join(ROOT, 'logs');
export const STATE_PATH = join(ROOT, 'state.json');
export const REFRESH_PATH = join(ROOT, 'refresh.mjs');
export const SWEEP_PATH = join(ROOT, 'sweep.mjs');
export const TEMPLATE_PATH = join(ROOT, 'template.html');
export const SWEEP_LOG_PATH = join(LOGS_DIR, 'sweep.jsonl');

// --- ntn CLI ---
// Absolute winget package exe. lib/notion.mjs enforces the non-interactive
// contract (closed stdin, timeout, windowsHide, fail-loud) around this exe.
// SINGLE SOURCE OF TRUTH (T8.1 #5): every consumer imports NTN_EXE from here
// (report-registry/config.mjs re-exports it). The NTN_EXE_PATH env var overrides
// the baked-in winget path for a different machine/install without a code edit.
export const NTN_EXE = process.env.NTN_EXE_PATH
  || join(homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages', 'Notion.ntn_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ntn-x86_64-pc-windows-msvc', 'ntn.exe');

// --- FourthOS Notion data source ids (databases) ---
export const PROJECTS_DS = '852a60e1-9fa6-4361-9b55-1a9f59d566d8';
export const DECISIONS_DS = 'e209f0f0-e7a6-45f1-9d2d-bc97d9811d60';
// Personal Life-OS Tasks DB: the FourthOS inline Tasks DB (5209d2a6…) exposes no
// data source to either integration, so v0 queries the personal DB scoped to the
// FourthOS project relation and open tasks via TASKS_QUERY below.
export const TASKS_DS = 'c3176fd7-ac82-825c-a03c-073837e5493c';
export const SPONSOR_DS = '10c0358a-ad62-486d-8493-5046800e9af1'; // Sponsor Report Approvals
export const TASKS_QUERY = {
  filter: {
    and: [
      { property: 'Project', relation: { contains: '34076fd7-ac82-805d-ac89-dd26476e2c47' } },
      { property: 'Completed?', checkbox: { equals: false } },
    ],
  },
};

// --- Mobile Cockpit (phone-first child page under the Daily Cockpit) ---
export const MOBILE_COCKPIT_PAGE_ID = '39376fd7-ac82-817e-b2b7-faa3da23078c'; // created 2026-07-04

// PM Notes data source id — filled by the one-time setup step (ntn POST
// v1/databases, MCP create-database fallback). Empty until then; consumers
// must treat '' as "not yet provisioned".
export const PM_NOTES_DS = 'bc7a9514-c5e2-4613-a6d2-37371dbdb430'; // PM Notes (DB c4347ee5…, created 2026-07-04)

// --- Mobile PM Portal section headings ---
export const CAPTURE_HEADING = '## 📓 Capture';
export const TRIAGE_LOG_HEADING = '## 🧾 Triage log';
export const NOTES_VIEW_HEADING = '## 🗒️ Notes';

// Days before an open `later:` PM note resurfaces in the queue/brief/digest.
// Env override first (mitigation #14 — S5 UAT sets PM_NOTES_AGE_DAYS=0 live).
const pmNotesAgeEnv = process.env.PM_NOTES_AGE_DAYS;
export const PM_NOTES_AGE_DAYS = (pmNotesAgeEnv != null && pmNotesAgeEnv !== '' && Number.isFinite(Number(pmNotesAgeEnv)))
  ? Number(pmNotesAgeEnv)
  : 3;

// Actor gate (mitigation #7): triage only consumes blocks whose created_by /
// last_edited_by id is in this allowlist. EMPTY = allow all (bootstrap mode).
// Fill with Dave's Notion user id + the integration's bot id at setup time.
export const TRIAGE_ACTOR_ALLOWLIST = [
  '600d5217-e24f-45e4-a8f1-8db25b77422e', // Dave
  '39276fd7-ac82-81c8-ab81-0027ce63b71a', // Notion CLI integration bot
];

// --- Reporting Hub (hosts the shared project-card gallery) ---
export const REPORTING_HUB_PAGE_ID = '38f76fd7ac8280478e50dd2956ba6e8a';

// --- section headings (matched verbatim by the MCP publish/hub steps) ---
export const CARD_SECTION_HEADING = '## 📊 Living Status Card';
export const HUB_SECTION_HEADING = '## 📇 FourthOS Project Cards';
export const MOBILE_INTRO_HEADING = '# 📱 Mobile Cockpit';
export const MOBILE_EMBED_HEADING = '## 🚨 Attention Queue';
export const AI_DIGEST_HEADING = '## 🤖 AI digest (machine-written)';

// --- Overview page ("Living Project Cards & Portfolio Cockpit") ---------------
// Hosts two EXAMPLE embeds under "## See it live" that must track the live
// surfaces (optimization 01: no orphan surfaces — they rotted untracked for 12
// days after the July-4 launch). The sweep republishes each when its live
// counterpart's published content changes.
export const OVERVIEW_PAGE_ID = '39376fd7-ac82-81ec-a734-d56cdd390c22';
// Section headings on the overview page (heading_3, inside "## See it live").
export const OVERVIEW_COCKPIT_HEADING = '### The Portfolio Cockpit';
export const OVERVIEW_CARD_HEADING = '### A project card';
// The roster card whose HTML doubles as the overview page's card example.
export const OVERVIEW_CARD_EXAMPLE_SLUG = 'connector-ecosystem';

// --- timeouts (ms) ---
export const NTN_TIMEOUT_MS = 30000;
export const REFRESH_TIMEOUT_MS = 120000;
export const CLAUDE_TIMEOUT_MS = 300000; // 5 min per headless claude publish

// --- state schema version ---
// Bump when the per-card shape changes in a way that needs migration.
export const STATE_VERSION = 1;

// CCv3 is the engine's pilot but is NOT a FourthOS Projects-DB row, so it is
// merged into the hub gallery from this static list rather than the live query.
export const STATIC_EXTRA_CARDS = [
  {
    projectName: 'CCv3 (pilot)',
    health: 'Green',
    status: 'Active',
    hostKind: 'notion',
    url: 'https://app.notion.com/p/39276fd7ac8281c697b8dc65e42168cb',
  },
];
