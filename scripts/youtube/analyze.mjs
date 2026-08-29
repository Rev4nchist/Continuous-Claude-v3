#!/usr/bin/env node
// One read-only model call per bounded evidence window; trusted code validates
// and promotes only complete output.
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { basename, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  analysisPrompt, buildAnalysisWindows, combineWindowResults,
  renderExhaustiveOutline, validateWindowResult,
} from './lib/analysis.mjs';
import { auditVideoCoverage } from './lib/coverage.mjs';
import { runReadOnlyAnalysis } from './lib/headless.mjs';
import { writeJsonAtomic } from './lib/records.mjs';

const evidencePath = process.argv[2];
if (!evidencePath || !existsSync(evidencePath)) {
  console.error('Usage: analyze.mjs <video.analysis.json> [--results <directory>]');
  process.exit(1);
}
const resultIndex = process.argv.indexOf('--results');
const resultDir = resultIndex === -1 ? null : process.argv[resultIndex + 1];
const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
if (evidence.transcript?.status !== 'complete' || evidence.visuals?.status !== 'extracted') {
  console.error('Analysis blocked: complete transcript and extracted visual states are required.');
  process.exit(2);
}

function stageWindow(window, root, index) {
  const assets = join(root, 'assets');
  mkdirSync(assets, { recursive: true });
  const copyAsset = (path, id) => {
    const target = join(assets, `${id.replace(/[^a-z0-9_-]/gi, '-')}${extname(path) || '.jpg'}`);
    copyFileSync(path, target);
    return target;
  };
  const staged = {
    ...window,
    items: window.items.map((item) => item.framePath ? { ...item, framePath: copyAsset(item.framePath, item.id) } : item),
    contactSheets: (window.contactSheets || []).map((sheet) => ({ ...sheet, path: copyAsset(sheet.path, sheet.id) })),
  };
  const path = join(root, `window-${String(index + 1).padStart(4, '0')}.json`);
  writeJsonAtomic(path, staged);
  return { staged, path };
}

const stageRoot = mkdtempSync(join(tmpdir(), `yt-analysis-${evidence.videoId}-`));
try {
  const windows = buildAnalysisWindows(evidence);
  const results = windows.map((window, index) => {
    const { staged, path: stagedPath } = stageWindow(window, stageRoot, index);
    const raw = resultDir
      ? JSON.parse(readFileSync(`${resultDir}/${window.id.replace(/:/g, '-')}.json`, 'utf8'))
      : runReadOnlyAnalysis(analysisPrompt(staged, basename(stagedPath)), { allowedRoot: stageRoot });
    return validateWindowResult(staged, raw);
  });
  const analysis = combineWindowResults(evidence.videoId, results);
  const reviewed = new Set(analysis.visualReviews.filter((review) => review.reviewed).map((review) => review.id));
  evidence.visuals.states = evidence.visuals.states.map((state) => ({ ...state, reviewed: reviewed.has(state.id) }));
  evidence.visuals.contactSheets = (evidence.visuals.contactSheets || []).map((sheet) => ({ ...sheet, reviewed: sheet.frameIds.every((id) => reviewed.has(id)) }));
  evidence.visuals.status = evidence.visuals.states.every((state) => state.reviewed) ? 'complete' : 'review-incomplete';
  evidence.gaps = (evidence.gaps || []).filter((gap) => gap.id !== 'visuals:review');
  if (evidence.visuals.status !== 'complete') evidence.gaps.push({ id: 'visuals:review', reason: 'One or more retained visual states were not reviewed.' });
  evidence.analysis = analysis;
  const audit = auditVideoCoverage(evidence, analysis);
  evidence.coverage = audit;
  evidence.coverageStatus = audit.status;
  writeJsonAtomic(evidencePath, evidence);
  if (audit.status !== 'READY') {
    console.error(JSON.stringify(audit, null, 2));
    process.exit(2);
  }
  const outlinePath = evidencePath.replace(/\.analysis\.json$/, '.outline.md');
  writeFileSync(outlinePath, renderExhaustiveOutline(evidence, analysis), 'utf8');
  console.log(JSON.stringify({ status: 'READY', videoId: evidence.videoId, windows: windows.length, outlinePath }, null, 2));
} catch (error) {
  console.error(`analyze failed: ${error.message}`);
  process.exit(1);
} finally {
  if (process.env.YT_KEEP_STAGE !== '1') {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}
