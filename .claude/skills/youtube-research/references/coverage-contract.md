# Coverage contract

## Boundary

`video-complete` covers the complete playlist, creator metadata, detected speech, retained
visual states, and exhaustive evidence mapping. External links, linked files, audience
comments, and unrelated channel videos are outside the default boundary. Preserve their
URLs for an optional source-research run.

## Video readiness

A video is `READY` only when all conditions are true:

- The playlist entry has a durable manifest record. Private, removed, unavailable,
  duplicated, and failed entries remain represented.
- Metadata retains title, URL, channel, playlist position, chapters, full description,
  duration, upload date, and source hashes.
- Each detected speech interval is covered by validated manual captions or local Whisper.
  Auto captions are reconciled with Whisper; risky name/number/tool differences are flags.
- Scene-change and periodic extraction produced visual candidates. OCR-aware perceptual
  deduplication retained material states, and the model reviewed every contact sheet/frame.
- Every transcript chunk and retained visual ID appears in at least one outline segment.
- Every non-obvious content unit has evidence and a valid timestamp.
- No failed extraction, unreviewed frame, unmapped evidence item, or inaccessible entry
  remains, unless an owner explicitly accepted that entry as an exclusion with a reason.

The deterministic audit is authoritative. Model confidence cannot override it.

## Topic and target readiness

Topic coverage accounts for every current playlist position plus retained history. A topic
cannot be `READY` while any active entry lacks a ready video audit or accepted exclusion.
Target packages remain blocked until all newly captured topic snapshots are fully analyzed.

## Status meanings

- `NoChange`: no source change, no backlog, no new target package.
- `Ready`: changed sources were completely promoted and target packages were generated.
- `Blocked`: known dependency, access, review, or evidence gap prevents completeness.
- `Warn`: useful atomic work landed, but the run ceiling or partial source error left queue.
- `Failed`: the run produced no trustworthy state transition or its state record is invalid.

Never translate `Blocked` or `Warn` into “complete with caveats.”
