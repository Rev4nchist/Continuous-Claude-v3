import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function findRepo(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'scripts', 'start-embedding-daemon.ps1'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = findRepo(process.cwd()) || findRepo(here);
if (!repo) {
  console.error('repo root not found');
  process.exit(1);
}
const text = fs.readFileSync(path.join(repo, 'scripts', 'start-embedding-daemon.ps1'), 'utf8').replace(/\r/g, '');
const fail = (msg) => { console.error(msg); process.exit(1); };

if (!/\$psi\.UseShellExecute\s*=\s*\$false/.test(text)) fail('UseShellExecute is not $false');
if (/\$psi\.UseShellExecute\s*=\s*\$true/.test(text)) fail('UseShellExecute $true opens a console window');
if (!/\$psi\.CreateNoWindow\s*=\s*\$true/.test(text)) fail('CreateNoWindow is not $true');
if (/\$psi\.CreateNoWindow\s*=\s*\$false/.test(text)) fail('CreateNoWindow $false shows a console window');
if (!/\$psi\.Arguments\s*=\s*"run --project opc python opc\/scripts\/core\/embedding_daemon\.py --daemon"/.test(text)) fail('daemon launch arguments changed');

const clearCall = text.search(/\$clearedPipes\s*=\s*\[Ccv3\.PipeInherit\]::Clear\(\)/);
const startMark = '[System.Diagnostics.Process]::Start($psi)';
const startCall = text.indexOf(startMark);
const tryIdx = startCall < 0 ? -1 : text.lastIndexOf('try {', startCall);
const finallyIdx = startCall < 0 ? -1 : text.indexOf('finally {', startCall);
if (clearCall < 0 || startCall < 0 || tryIdx < clearCall) fail('Start is not preceded by PipeInherit.Clear');
const endFinally = finallyIdx < 0 ? -1 : text.indexOf('\n}', finallyIdx);
const finallyBody = endFinally < 0 ? '' : text.slice(finallyIdx, endFinally);
if (!finallyBody.includes('[Ccv3.PipeInherit]::Restore($clearedPipes)')) fail('Restore is not inside the finally that follows Start');
if (!text.slice(tryIdx, Math.max(finallyIdx, tryIdx)).includes(startMark)) fail('Start is not inside the try');

const clearStart = text.indexOf('public static System.Collections.Generic.List<long> Clear()');
const restoreDef = text.indexOf('public static void Restore');
if (clearStart < 0 || restoreDef < clearStart) fail('PipeInherit.Clear is missing');
const method = text.slice(clearStart, restoreDef);
if (!/GetFileType\(h\)\s*!=\s*3/.test(method)) fail('Clear does not limit itself to pipes');
if (!/SetHandleInformation\(h,\s*1,\s*0\)/.test(method)) fail('Clear does not drop HANDLE_FLAG_INHERIT');
const loop = method.match(/for\s*\(\s*long\s+v\s*=\s*(\d+)\s*;\s*v\s*<\s*(0x[0-9a-fA-F]+|\d+)\s*;\s*v\s*\+=\s*4\s*\)/);
if (!loop) fail('Clear does not scan handles; std handles alone leave the caller pipe open');
if (Number(loop[1]) > 4 || Number(loop[2]) < 0x10000) fail('Clear scan misses ordinary pipe handles');
console.log('daemon spawn clears inheritable pipes and hides the console');
