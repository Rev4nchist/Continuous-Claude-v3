import { contentHash } from './records.mjs';

function union(...arrays) {
  return [...new Set(arrays.flat().filter(Boolean))];
}

function unitKey(unit) {
  return contentHash({ kind: unit.kind, text: unit.text.trim().toLowerCase().replace(/\s+/g, ' ') });
}

export function mergeTopicKnowledge(existing, analyses, {
  topic, now = new Date().toISOString(), fullReconciliation = false,
} = {}) {
  const byKey = new Map((existing?.units || []).map((unit) => [unit.key, { ...unit }]));
  for (const analysis of analyses) {
    for (const unit of analysis.contentUnits || []) {
      const key = unitKey(unit);
      const prior = byKey.get(key);
      const relationships = unit.relationships || {};
      byKey.set(key, {
        key,
        kind: unit.kind,
        text: unit.text,
        stance: unit.stance || prior?.stance || 'asserted',
        confidence: unit.confidence ?? prior?.confidence ?? null,
        firstSeen: prior?.firstSeen || now,
        lastConfirmed: now,
        evidenceIds: union(prior?.evidenceIds || [], unit.evidenceIds || []),
        supportingVideoIds: union(prior?.supportingVideoIds || [], analysis.videoId),
        contradicts: union(prior?.contradicts || [], relationships.contradicts || []),
        supersedes: union(prior?.supersedes || [], relationships.supersedes || []),
        relationshipRationales: prior?.relationshipRationales || [],
      });
    }
  }
  return {
    schemaVersion: 1,
    topic: topic || existing?.topic,
    updatedAt: now,
    lastFullReconciliationAt: fullReconciliation ? now : existing?.lastFullReconciliationAt || null,
    units: [...byKey.values()].sort((left, right) => left.kind.localeCompare(right.kind) || left.text.localeCompare(right.text)),
  };
}

export function renderMasterOutline(topic, records) {
  const lines = [`# ${topic} — master evidence outline`, '',
    '_This is a cumulative, detail-preserving index. It is not a summary._', '',
  ];
  for (const record of records) {
    const title = record.evidence.metadata?.title || record.evidence.videoId;
    lines.push(`## ${title}`, '', `Video ID: ${record.evidence.videoId}`, '');
    for (const segment of record.analysis.outlineSegments || []) {
      lines.push(`### ${segment.title || 'Content'} (${segment.start}–${segment.end}s)`, '');
      for (const detail of segment.details || []) lines.push(`- ${detail}`);
      lines.push('', `Evidence: ${[...(segment.transcriptChunkIds || []), ...(segment.visualFrameIds || [])].join(', ')}`, '');
    }
  }
  return `${lines.join('\n')}\n`;
}

export function applyTopicRelationships(knowledge, result) {
  if (!result || !Array.isArray(result.relationships)) throw new Error('Topic relationship result requires relationships.');
  const units = new Map(knowledge.units.map((unit) => [unit.key, { ...unit }]));
  for (const relationship of result.relationships) {
    if (!['contradicts', 'supersedes'].includes(relationship.type)) throw new Error(`Invalid topic relationship type: ${relationship.type}`);
    if (!units.has(relationship.fromKey) || !units.has(relationship.toKey) || relationship.fromKey === relationship.toKey) {
      throw new Error('Topic relationship references invalid unit keys.');
    }
    const from = units.get(relationship.fromKey);
    const to = units.get(relationship.toKey);
    const knownEvidence = new Set([...(from.evidenceIds || []), ...(to.evidenceIds || [])]);
    if (!Array.isArray(relationship.evidenceIds) || !relationship.evidenceIds.length
      || relationship.evidenceIds.some((id) => !knownEvidence.has(id))) {
      throw new Error('Topic relationship requires valid supporting evidence ids.');
    }
    from[relationship.type] = union(from[relationship.type] || [], relationship.toKey);
    from.relationshipRationales = [
      ...(from.relationshipRationales || []).filter((item) => !(item.type === relationship.type && item.toKey === relationship.toKey)),
      { type: relationship.type, toKey: relationship.toKey, rationale: relationship.rationale, evidenceIds: relationship.evidenceIds || [] },
    ];
  }
  return { ...knowledge, units: [...units.values()] };
}
