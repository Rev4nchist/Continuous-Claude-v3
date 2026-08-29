#!/usr/bin/env node
// Complete local evidence extraction for one staged VideoEvidence record.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CACHE_ROOT } from './lib/config.mjs';
import {
  chooseCanonicalTranscript, downloadResearchMedia, extractVisualStates, mediaDoctor,
  transcriptDisagreements, transcribeWithWhisper,
} from './lib/media.mjs';
import { writeJsonAtomic } from './lib/records.mjs';

function normalizeWhisper(videoId, result, provenance = 'whisper') {
  return result.segments.map((segment, index) => ({
    ...segment,
    id: `transcript:${videoId}:${String(index + 1).padStart(5, '0')}`,
    t: segment.start,
    provenance,
  }));
}

function replaceGap(gaps, prefix, replacement = []) {
  return [...(gaps || []).filter((gap) => !gap.id.startsWith(prefix)), ...replacement];
}

const evidencePath = process.argv[2];
if (!evidencePath || !existsSync(evidencePath)) {
  console.error('Usage: extract.mjs <path-to-video.analysis.json>');
  process.exit(1);
}

const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
const dependencyReport = mediaDoctor();
evidence.tooling = dependencyReport;
if (!dependencyReport.ready) {
  evidence.gaps = replaceGap(evidence.gaps, 'tooling:', [{
    id: 'tooling:media',
    reason: `Required local tools unavailable: ${dependencyReport.tools.filter((tool) => !tool.available).map((tool) => tool.name).join(', ')}`,
  }]);
  evidence.coverageStatus = 'BLOCKED';
  writeJsonAtomic(evidencePath, evidence);
  console.error(evidence.gaps.at(-1).reason);
  process.exit(2);
}

const videoId = evidence.videoId;
const cacheDir = join(CACHE_ROOT, videoId, `${Date.now()}-${process.pid}`);
const evidenceDir = evidencePath.replace(/\.analysis\.json$/, '.evidence');
try {
  const { videoPath, audioPath } = downloadResearchMedia(videoId, cacheDir);
  const languageHint = evidence.transcript?.language?.split('-')[0] || null;
  const whisper = transcribeWithWhisper(audioPath, { language: languageHint, task: 'transcribe' });
  const whisperChunks = normalizeWhisper(videoId, whisper);
  const captionChunks = evidence.transcript?.chunks || [];
  const speechWindows = whisperChunks.map((chunk) => ({ id: `speech:${videoId}:${chunk.id.split(':').at(-1)}`, start: chunk.start, end: chunk.end }));
  const selection = chooseCanonicalTranscript({
    captionProvenance: evidence.transcript?.provenance,
    captionChunks, whisperChunks, speechWindows,
  });
  const canonical = selection.chunks;
  evidence.transcript = {
    ...evidence.transcript,
    status: canonical.length ? 'complete' : 'failed',
    language: whisper.language || languageHint,
    languageProbability: whisper.languageProbability,
    model: whisper.model,
    device: whisper.device,
    speechWindows,
    chunks: canonical,
    canonicalProvenance: selection.provenance,
    captionChunks,
    whisperChunks,
    disagreements: captionChunks.length ? transcriptDisagreements(captionChunks, whisperChunks) : [],
  };
  if (whisper.language && !whisper.language.toLowerCase().startsWith('en')) {
    const translated = transcribeWithWhisper(audioPath, { language: whisper.language, task: 'translate' });
    evidence.transcript.englishDerivative = normalizeWhisper(videoId, translated, 'whisper-translation');
  }
  evidence.visuals = extractVisualStates(videoId, videoPath, evidenceDir);
  evidence.gaps = replaceGap(replaceGap(evidence.gaps, 'transcript:'), 'tooling:');
  evidence.gaps = replaceGap(evidence.gaps, 'visuals:', [{ id: 'visuals:review', reason: 'Extracted visual states and contact sheets require model review.' }]);
  evidence.coverageStatus = 'BLOCKED';
  evidence.extractedAt = new Date().toISOString();
  writeJsonAtomic(evidencePath, evidence);
  console.log(JSON.stringify({ videoId, transcriptChunks: canonical.length, visualStates: evidence.visuals.states.length, evidencePath, evidenceDir: basename(evidenceDir) }, null, 2));
} catch (error) {
  evidence.gaps = replaceGap(evidence.gaps, 'extraction:', [{ id: 'extraction:failed', reason: error.message }]);
  evidence.coverageStatus = 'BLOCKED';
  writeJsonAtomic(evidencePath, evidence);
  console.error(`extract failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (cacheDir.startsWith(CACHE_ROOT)) rmSync(cacheDir, { recursive: true, force: true });
}
