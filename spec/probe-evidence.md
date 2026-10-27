# Slice 1 probe evidence — 2026-10-27

No key material anywhere in this file. The Meta key was read transiently
in-process from the Meta goal's `hidden_files/.env` and never printed,
logged, stored, or committed.

## S1.2 — Meta API reachability

- `GET https://api.meta.ai/v1/models` → **HTTP 200**.
- Key present (non-empty). Models listed include `sam-3.1` and
  `muse-spark-1.3` (plus `muse-wonder-1.0`, `muse-voice-transcribe-1.0`,
  `muse-image-1.0`, `muse-spark-1.3-contributor`, `muse-spark-1.2*`,
  `muse-spark-1.1`).
- Conclusion: auth + billing path work; SAM 3.1 is available on this key.

## S1.3 — One real SAM 3.1 segmentation (THE GATE: PASSED)

- Method (matches current Meta docs, Context7 `/websites/dev_meta_ai`,
  `https://dev.meta.ai/docs/media-segmentation` and
  `https://dev.meta.ai/docs/sam/client-libraries` — docs AGREE with the
  blueprint, no deviation): `POST https://api.meta.ai/v1/responses`,
  `model: "sam-3.1"`, single user message with `input_text: "cardboard box"`
  + `input_image` as a base64 PNG data URL, `stream: true`,
  `metadata: { mask_encoding: "one_bit" }`, parsed with
  `@meta-sam/parser` `parseImageStream` + `recordsOfKind`.
- Test image: `spec/probe-shelf.png` (1200×800, synthetic shelf drawn with
  PIL: 2 planks + 6 distinct cardboard boxes, ground-truth count = 6).
- Result: `outcome.status = "completed"`, latency **2007 ms**,
  **6 mask records + 6 box records**, objectIds 0–5 (unique, no duplicates).
- Boxes returned (left, top, right, bottom) vs ground truth:
  - 960, 190, 1111, 371 — truth 960–1110, 190–370 ✓
  - 760, 210, 920, 370 — truth 760–920, 210–370 ✓
  - 301, 431, 510, 670 — truth 300–510, 430–670 ✓
  - 101, 181, 290, 370 — truth 100–290, 180–370 ✓
  - 321, 201, 491, 370 — truth 320–490, 200–370 ✓
  - 521, 171, 720, 370 — truth 520–720, 170–370 ✓
- Count accuracy on this probe: **6/6, coordinates within ~1 px**.
- Mask records carry `kind, order, objectId, identity, revision, mask, bounds`
  (mask payloads not dumped here — large binary raster data).

## Unverified / caveats

- Synthetic image, not a real warehouse photo: proves API access, parsing,
  and counting mechanics, NOT real-world accuracy. Slice 3 validates against
  manual annotations on real photos.
- Prompt used was the generic noun phrase "cardboard box"; the demo SKU
  prompt ("BOX-RED" style) is still to be tuned in Slice 3.
- Credit balance / rate limits on the key were not checked (no dashboard
  access from here); one probe call cost is unknown but the call succeeded
  with no billing error.
