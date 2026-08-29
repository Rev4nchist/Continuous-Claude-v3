function issue(code, detail, evidenceId = null) {
  return { code, detail, evidenceId };
}

function mappedIds(segments, field) {
  return new Set((segments || []).flatMap((segment) => segment[field] || []));
}

export function auditVideoCoverage(evidence, analysis, { acceptedGaps = [] } = {}) {
  const issues = [];
  const accepted = new Set(acceptedGaps.map((gap) => gap.id));
  const chunks = evidence?.transcript?.chunks || [];
  const speechWindows = evidence?.transcript?.speechWindows || [];
  const visuals = evidence?.visuals?.states || [];
  const transcriptMapped = mappedIds(analysis?.outlineSegments, 'transcriptChunkIds');
  const visualMapped = mappedIds(analysis?.outlineSegments, 'visualFrameIds');

  if (evidence?.transcript?.status !== 'complete') issues.push(issue('TRANSCRIPT_INCOMPLETE', 'Speech coverage is not complete.'));
  if (evidence?.visuals?.status !== 'complete') issues.push(issue('VISUAL_REVIEW_INCOMPLETE', 'Visual-state review is not complete.'));
  for (const gap of evidence?.gaps || []) {
    if (!accepted.has(gap.id)) issues.push(issue('UNACCEPTED_GAP', gap.reason || 'Evidence gap requires review.', gap.id));
  }
  for (const chunk of chunks) {
    if (!Number.isFinite(chunk.start) || !Number.isFinite(chunk.end) || chunk.start < 0 || chunk.end < chunk.start || chunk.end > Number(evidence.duration || 0)) {
      issues.push(issue('INVALID_TIMESTAMP', 'Transcript chunk is outside the video duration.', chunk.id));
    }
    if (!transcriptMapped.has(chunk.id)) issues.push(issue('UNMAPPED_TRANSCRIPT', 'Transcript chunk is absent from the outline.', chunk.id));
  }
  for (const speech of speechWindows) {
    const overlap = chunks.reduce((total, chunk) => total + Math.max(0, Math.min(speech.end, chunk.end) - Math.max(speech.start, chunk.start)), 0);
    if (overlap / Math.max(0.001, speech.end - speech.start) < 0.8) issues.push(issue('UNCOVERED_SPEECH', 'Detected speech window lacks sufficient transcript coverage.', speech.id));
  }
  for (const visual of visuals) {
    if (!Number.isFinite(visual.timestamp) || visual.timestamp < 0 || visual.timestamp > Number(evidence.duration || 0)) issues.push(issue('INVALID_TIMESTAMP', 'Visual state is outside the video duration.', visual.id));
    if (!visual.reviewed) issues.push(issue('UNREVIEWED_VISUAL', 'Retained visual state was not reviewed.', visual.id));
    if (!visualMapped.has(visual.id)) issues.push(issue('UNMAPPED_VISUAL', 'Visual state is absent from the outline.', visual.id));
  }
  for (const segment of analysis?.outlineSegments || []) {
    if (segment.start < 0 || segment.end < segment.start || segment.end > Number(evidence.duration || 0)) {
      issues.push(issue('INVALID_TIMESTAMP', `Outline segment ${segment.id} is outside the video duration.`, segment.id));
    }
    const known = new Set([...chunks.map((item) => item.id), ...visuals.map((item) => item.id)]);
    for (const id of [...(segment.transcriptChunkIds || []), ...(segment.visualFrameIds || [])]) {
      if (!known.has(id)) issues.push(issue('INVALID_EVIDENCE_REFERENCE', `Outline segment ${segment.id} cites unknown evidence.`, id));
    }
  }
  const knownEvidence = new Set([...chunks.map((item) => item.id), ...visuals.map((item) => item.id)]);
  for (const unit of analysis?.contentUnits || []) {
    if (!Array.isArray(unit.evidenceIds) || unit.evidenceIds.length === 0) {
      issues.push(issue('UNCITED_CONTENT_UNIT', `Content unit ${unit.id} has no evidence.`, unit.id));
    }
    for (const id of unit.evidenceIds || []) if (!knownEvidence.has(id)) issues.push(issue('INVALID_EVIDENCE_REFERENCE', `Content unit ${unit.id} cites unknown evidence.`, id));
  }

  const ratio = (mapped, all) => all.length === 0 ? 1 : all.filter((item) => mapped.has(item.id)).length / all.length;
  return {
    videoId: evidence?.videoId,
    status: issues.length === 0 ? 'READY' : 'BLOCKED',
    coverage: {
      transcript: ratio(transcriptMapped, chunks), visual: ratio(visualMapped, visuals),
      speech: speechWindows.length ? 1 - issues.filter((item) => item.code === 'UNCOVERED_SPEECH').length / speechWindows.length : 1,
    },
    issues,
  };
}

export function auditTopicCoverage({ entries = [], videoAudits = [], acceptedExclusions = [] }) {
  const audits = new Map(videoAudits.map((audit) => [audit.videoId, audit]));
  const exclusions = new Map(acceptedExclusions.map((item) => [item.entryKey, item]));
  const unresolved = [];
  let excludedCount = 0;
  for (const entry of entries) {
    if (exclusions.has(entry.entryKey)) {
      excludedCount += 1;
      continue;
    }
    const audit = entry.id ? audits.get(entry.id) : null;
    if (!audit || audit.status !== 'READY') unresolved.push({ entryKey: entry.entryKey, videoId: entry.id, issues: audit?.issues || [] });
  }
  return {
    status: unresolved.length === 0 ? 'READY' : 'BLOCKED',
    accounting: { entries: entries.length, ready: entries.length - unresolved.length - excludedCount, acceptedExclusions: excludedCount, unresolved: unresolved.length },
    unresolved,
  };
}
