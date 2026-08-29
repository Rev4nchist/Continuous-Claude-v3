import { spawnSync } from 'node:child_process';
import {
  copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  FFMPEG_EXE, PERIODIC_FRAME_SECONDS, PYTHON_EXE, RESEARCH_VIDEO_HEIGHT,
  TESSERACT_EXE, WHISPER_COMPUTE_TYPE, WHISPER_DEVICE, WHISPER_MODEL,
  YTDLP_EXE, YT_ROOT,
} from './config.mjs';
import { contentHash } from './records.mjs';
import { ytdlpAuthArgs } from './ytdlp.mjs';

const PROCESS_TIMEOUT_MS = Number(process.env.YT_MEDIA_TIMEOUT_MS || 90 * 60 * 1000);

function run(executable, args, { timeout = PROCESS_TIMEOUT_MS, allowFailure = false } = {}) {
  const result = spawnSync(executable, args, {
    timeout, windowsHide: true, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, input: '',
  });
  if (result.error) throw new Error(`${executable} unavailable: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${executable} exited ${result.status}: ${(result.stderr || result.stdout || '').trim().slice(0, 1600)}`);
  }
  return result;
}

function probe(name, executable, args) {
  try {
    const result = run(executable, args, { timeout: 15_000 });
    return { name, executable, available: true, version: (result.stdout || result.stderr).split(/\r?\n/)[0].trim() };
  } catch (error) {
    return { name, executable, available: false, error: error.message };
  }
}

export function mediaDoctor() {
  const tools = [
    probe('yt-dlp', YTDLP_EXE, ['--version']),
    probe('ffmpeg', FFMPEG_EXE, ['-version']),
    probe('tesseract', TESSERACT_EXE, ['--version']),
    probe('python', PYTHON_EXE, ['--version']),
    probe('Pillow', PYTHON_EXE, ['-c', 'import PIL; print(PIL.__version__)']),
  ];
  const whisper = probe(
    'faster-whisper', PYTHON_EXE,
    ['-c', 'import faster_whisper; print(faster_whisper.__version__)'],
  );
  tools.push(whisper);
  return { ready: tools.every((tool) => tool.available), tools };
}

export function downloadResearchMedia(videoId, outputDir) {
  mkdirSync(outputDir, { recursive: true });
  const base = join(outputDir, videoId);
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  run(YTDLP_EXE, [
    ...ytdlpAuthArgs(),
    '--no-update', '--no-playlist', '--no-warnings',
    '-f', `bv*[height<=${RESEARCH_VIDEO_HEIGHT}]+ba/b[height<=${RESEARCH_VIDEO_HEIGHT}]`,
    '--merge-output-format', 'mp4', '-o', `${base}.%(ext)s`, url,
  ]);
  const videoPath = readdirSync(outputDir)
    .map((name) => join(outputDir, name))
    .find((path) => basename(path).startsWith(`${videoId}.`) && !path.endsWith('.audio.wav'));
  if (!videoPath) throw new Error(`Media download produced no video for ${videoId}.`);
  const audioPath = `${base}.audio.wav`;
  run(FFMPEG_EXE, ['-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', audioPath]);
  return { videoPath, audioPath };
}

export function whisperArguments(audioPath, {
  language = null, task = 'transcribe', model = WHISPER_MODEL,
  device = WHISPER_DEVICE, computeType = WHISPER_COMPUTE_TYPE,
} = {}) {
  const script = join(YT_ROOT, 'python', 'transcribe.py');
  const args = [script, '--audio', resolve(audioPath)];
  if (model) args.push('--model', model);
  if (device) args.push('--device', device);
  if (computeType) args.push('--compute-type', computeType);
  if (language) args.push('--language', language);
  args.push('--task', task);
  return args;
}

export function transcribeWithWhisper(audioPath, options = {}) {
  const args = whisperArguments(audioPath, options);
  const result = run(PYTHON_EXE, args);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Whisper adapter returned invalid JSON: ${result.stdout.slice(0, 500)}`);
  }
}

function parseSceneTimestamps(stderr) {
  return [...String(stderr).matchAll(/pts_time:([0-9.]+)/g)].map((match) => Number(match[1]));
}

export function parseTesseractTsv(tsv) {
  const rows = String(tsv).split(/\r?\n/).slice(1).map((line) => line.split('\t')).filter((columns) => columns.length >= 12);
  const words = rows.filter((columns) => columns[11]?.trim()).map((columns) => ({ text: columns[11].trim(), confidence: Number(columns[10]) }));
  const confident = words.filter((word) => Number.isFinite(word.confidence) && word.confidence >= 0);
  return {
    text: words.map((word) => word.text).join(' '),
    confidence: confident.length ? confident.reduce((sum, word) => sum + word.confidence, 0) / confident.length : null,
  };
}

function runTesseract(framePath) {
  const result = run(TESSERACT_EXE, [framePath, 'stdout', 'tsv'], { allowFailure: true });
  if (result.status !== 0) return { text: '', confidence: null };
  return parseTesseractTsv(result.stdout);
}

function perceptualHash(framePath) {
  const script = join(YT_ROOT, 'python', 'frame_hash.py');
  const result = run(PYTHON_EXE, [script, resolve(framePath)], { timeout: 30_000, allowFailure: true });
  if (result.status === 0 && /^[01]{64}$/.test(result.stdout.trim())) return result.stdout.trim();
  return contentHash(readFileSync(framePath));
}

function labelFrame(sourcePath, selectedPath, label) {
  const script = join(YT_ROOT, 'python', 'label_frame.py');
  const result = run(PYTHON_EXE, [script, resolve(sourcePath), resolve(selectedPath), label], { timeout: 30_000, allowFailure: true });
  if (result.status !== 0) throw new Error(`Timestamp labeling failed for ${sourcePath}: ${(result.stderr || result.stdout).slice(0, 400)}`);
}

function hamming(left, right) {
  if (left.length !== right.length || !/^[01]+$/.test(left)) return left === right ? 0 : Infinity;
  let distance = 0;
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) distance += 1;
  return distance;
}

export function shouldRetainVisual(previous, candidate) {
  if (!previous) return true;
  const ocrChanged = contentHash(String(candidate.ocrText || '').trim().toLowerCase()) !== previous.ocrHash;
  return hamming(previous.perceptualHash, candidate.perceptualHash) > 4 || ocrChanged;
}

export function visualSelectionFilter(interval = PERIODIC_FRAME_SECONDS) {
  return `select='isnan(prev_selected_t)+gt(scene,0.32)+gte(t-prev_selected_t,${interval})',showinfo`;
}

export function extractVisualStates(videoId, videoPath, outputDir) {
  const candidatesDir = join(outputDir, 'candidates');
  const selectedDir = join(outputDir, 'selected');
  mkdirSync(candidatesDir, { recursive: true });
  mkdirSync(selectedDir, { recursive: true });
  const filter = visualSelectionFilter();
  const result = run(FFMPEG_EXE, [
    '-y', '-i', videoPath, '-vf', filter, '-vsync', 'vfr', '-q:v', '3', join(candidatesDir, 'frame-%06d.jpg'),
  ], { allowFailure: true });
  if (result.status !== 0 && readdirSync(candidatesDir).length === 0) {
    throw new Error(`FFmpeg visual extraction failed: ${result.stderr.slice(0, 1200)}`);
  }
  const timestamps = parseSceneTimestamps(result.stderr);
  const candidates = readdirSync(candidatesDir).filter((name) => name.endsWith('.jpg')).sort();
  const retained = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const sourcePath = join(candidatesDir, candidates[index]);
    const ocr = runTesseract(sourcePath);
    const hash = perceptualHash(sourcePath);
    const previous = retained.at(-1);
    if (!shouldRetainVisual(previous, { ocrText: ocr.text, perceptualHash: hash })) continue;
    const id = `visual:${videoId}:${String(retained.length + 1).padStart(5, '0')}`;
    const selectedPath = join(selectedDir, `${String(retained.length + 1).padStart(5, '0')}.jpg`);
    const timestamp = timestamps[index] ?? index * PERIODIC_FRAME_SECONDS;
    labelFrame(sourcePath, selectedPath, `${id}  ${timestamp.toFixed(1)}s`);
    retained.push({
      id, timestamp,
      path: selectedPath, ocrText: ocr.text, ocrConfidence: ocr.confidence,
      ocrHash: contentHash(ocr.text.trim().toLowerCase()), perceptualHash: hash,
      reviewed: false,
    });
  }
  const contactSheets = buildContactSheets(selectedDir, retained);
  rmSync(candidatesDir, { recursive: true, force: true });
  return { status: retained.length ? 'extracted' : 'failed', states: retained, contactSheets };
}

function buildContactSheets(selectedDir, states) {
  const sheets = [];
  for (let offset = 0; offset < states.length; offset += 16) {
    const batch = states.slice(offset, offset + 16);
    const batchDir = join(dirname(selectedDir), `sheet-${String(sheets.length + 1).padStart(3, '0')}`);
    mkdirSync(batchDir, { recursive: true });
    batch.forEach((state, index) => copyFileSync(state.path, join(batchDir, `frame-${String(index + 1).padStart(2, '0')}.jpg`)));
    const path = `${batchDir}.jpg`;
    run(FFMPEG_EXE, [
      '-y', '-framerate', '1', '-i', join(batchDir, 'frame-%02d.jpg'),
      '-vf', "scale=480:-1,tile=4x4:padding=8:margin=8", '-frames:v', '1', path,
    ]);
    rmSync(batchDir, { recursive: true, force: true });
    sheets.push({
      id: `sheet:${String(sheets.length + 1).padStart(3, '0')}`,
      path,
      frameIds: batch.map((state) => state.id),
      frames: batch.map((state) => ({ id: state.id, timestamp: state.timestamp })),
      reviewed: false,
    });
  }
  return sheets;
}

export function transcriptDisagreements(captionChunks, whisperChunks) {
  const important = (chunks) => new Set(
    chunks.flatMap((chunk) => chunk.text.match(/\b(?:\d+(?:\.\d+)?%?|[A-Z][A-Za-z0-9.+_-]{2,})(?!\w)/g) || []),
  );
  const captions = important(captionChunks);
  const whisper = important(whisperChunks);
  return [...new Set([...captions, ...whisper])]
    .filter((term) => !captions.has(term) || !whisper.has(term))
    .map((term) => ({ term, inCaptions: captions.has(term), inWhisper: whisper.has(term), status: 'review' }));
}

export function chooseCanonicalTranscript({ captionProvenance, captionChunks = [], whisperChunks = [], speechWindows = [] }) {
  const covered = speechWindows.every((window) => {
    const overlap = captionChunks.reduce((total, chunk) => total + Math.max(0, Math.min(window.end, chunk.end) - Math.max(window.start, chunk.start)), 0);
    return overlap / Math.max(0.001, window.end - window.start) >= 0.8;
  });
  if (captionProvenance === 'manual' && captionChunks.length && covered) {
    return { chunks: captionChunks, provenance: 'manual-caption', coveragePassed: true };
  }
  return { chunks: whisperChunks, provenance: 'whisper', coveragePassed: whisperChunks.length > 0 };
}
