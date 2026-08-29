# Evidence and storage schema

## Durable records

- `PlaylistSource`: stable id, kind, URL, topic, cadence, coverage mode, active flag, channel
  or playlist identity, optional channel limit, and explicitly linked target IDs.
- `PlaylistSnapshot`: capture time, ordered entries, availability, duplicate occurrence keys,
  additions, removals, reorders, metadata changes, and a canonical SHA-256 hash.
- `VideoEvidence`: complete metadata, source hashes, transcript provenance and coverage,
  Whisper/caption disagreements, visual states, OCR confidence, contact sheets, gaps, audit,
  and promoted analysis.
- `OutlineSegment`: stable id, start/end, detailed narrative, transcript chunk IDs, and visual
  frame IDs.
- `ContentUnit`: claim, definition, metric, procedure, tool, example, case study,
  counterpoint, quotation, prediction, or visual explanation; includes stance, confidence,
  evidence IDs, and contradiction/supersession relationships.
- `TargetProfile`: path/type, audience, objective, topics, update policy, and identity.
- `TargetChange`: add/revise/retract/flag, exact locator, before/proposed copy, rationale,
  evidence IDs, confidence, visual direction, layout risk, and review state.

## Layout

```text
docs/research/youtube/
  <channel>/<date>-<video-id>.md
  <channel>/<date>-<video-id>.analysis.json
  <channel>/<date>-<video-id>.outline.md
  <channel>/<date>-<video-id>.evidence/
  _playlists/<playlist-id>/manifest.json
  _playlists/<playlist-id>/snapshots/*.json
  _topics/<topic>/knowledge.json
  _topics/<topic>/master-outline.md
  _topics/<topic>/coverage.json
  _targets/<target-id>/profile.json
  _updates/<run-id>/<target-id>.json
  _updates/<run-id>/<target-id>.md
```

Raw media and intermediate frames live under the untracked cache and are removed after
successful extraction. Normalized transcripts, OCR, selected frames/contact sheets, hashes,
outlines, and citations persist. YouTube ID is canonical across playlists; do not analyze a
video twice because it appears in two topics.

## Incremental knowledge

Each normalized topic unit retains `firstSeen`, `lastConfirmed`, supporting video/evidence
IDs, and contradiction/supersession links. Incremental merges are idempotent. Run periodic
full reconciliation to detect drift that exact normalized matching cannot infer safely.
