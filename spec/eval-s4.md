# Slice 4 evaluation — video tracking (2026-10-27)

Method: synthetic clips generated with ffmpeg from the Slice 1 probe shelf
image (6 labeled boxes). Clips were probed directly against the Meta API
first (probe/sam-video-probe.mjs), then re-verified through the real
server API (`POST /api/scans` + poll). Truth for every clip: 6 physical
boxes. No real warehouse video exists yet.

## Transport (verified, not assumed)

- MP4 upload via Meta Files API, purpose `user_data` → file id returned.
- `sam-3.1` Responses call with an `input_video` part carrying the
  file_id (a Meta extension the OpenAI SDK types do not name; sent as a
  plain wire object). Parsed with `parseVideoStream`; objectIds are
  stable across frames of one response, so unique objectIds = count.
- Context7's CLI was broken in this environment (missing
  `dynamic_credentials` module); the video flow was instead verified
  against Meta's published protocol doc (meta-models/meta-sam
  protocol/sam3.md), the installed @meta-sam/parser README + types, and
  live API responses.

## Probe results (direct Meta API)

| Clip | Outcome | Unique objects | Per-frame counts | Notes |
|---|---|---|---|---|
| shelf-pan.mp4 (slow crop pan, 4s/40f) | completed 3.6s | 6 | 6/frame from f8 | Run 1: objects f7–39 |
| shelf-pan.mp4 repeat | completed | 6 | 5/frame to f25, 6 after | Run 2: object 5 joins at f26 — deduped total still 6 |
| shelf-static.mp4 (static crop) | completed 3.1s | 0 | none | Zero detections, twice, two files |
| shelf-occl.mp4 (drawbox attempt) | completed 2.9s | 0 | none | drawbox never rendered (ffmpeg `t` evaluated once at config) — clip was actually static; see below |
| shelf-occl2.mp4 (static crop + moving black bar via overlay) | completed 3.0s | 0 | none | Bar verified present in frames; still zero |
| shelf-panbar.mp4 (pan + moving bar) | completed 4.4s | 6 | mostly 6, dips to 4–5 at occlusion moments | Identity holds: same 6 ids f0–39, no duplicates |

## Finding: video tracking needs camera motion

Static-camera clips return zero detections reproducibly, even with a
moving occluder in frame. With camera motion, tracking is stable and
occlusion does not break identity. This is a measured SAM video
behavior on synthetic content, not a proven general rule — but it is
consistent across 5 video calls. Consequences implemented: zero-box
video = `unknown` → `needs_review` (never zero stock); UI advises a slow
pan and says plainly a static shot can return nothing; the demo video
MUST be a slow pan.

## Server API verification (real upload path)

| Clip | Status | Visible | Coverage | Raw box records | video_stats |
|---|---|---|---|---|---|
| shelf-pan.mp4 | analyzed | 6 | partial | 197 | frames 33/40, unique 6 |
| shelf-static.mp4 | analyzed | 0 | unknown | 0 | frames 0, maxFrame -1, unique 0 |
| shelf-panbar.mp4 | analyzed | 6 | partial | 232 | frames 40/40, unique 6 |

`partial` on the pan clips is honest, not a bug: the ffmpeg crop cuts
the shelf's right edge, so representative boxes touch the frame border
(2% rule). A demo clip framed to show the whole shelf would not trip
it. Counts are exact in all three cases (6 / 0-unknown / 6).

## S4.2 DECISION: KEEP VIDEO (no photo-only cut)

Evidence for keeping: moving-camera tracking dedupes correctly (6
unique ids across 2 pan runs + 1 occlusion run, no id explosion, no
double-count); occlusion degrades per-frame counts gracefully (4–5)
without corrupting the deduped total; the static-clip failure mode is
safe (unknown → needs_review) and explainable in the UI. Cutting to
photo-only would discard a working, demo-strong capability on the basis
of a failure mode that already degrades safely. Photo remains the
reliable fallback for static shots. The demo video must be a slow pan.
