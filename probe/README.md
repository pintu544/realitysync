# probe/

Reproducible Slice 1 SAM gate probe (QA W1 carry-over into Slice 2).

- Run: `MODEL_API_KEY=<from env only> NODE_USE_ENV_PROXY=1 node sam-probe.mjs`
- The key comes from the environment ONLY. It is never printed, logged,
  stored, or committed. The canonical key location is the Meta goal's
  `hidden_files/.env` (mode 600, outside any repo) — read it transiently.
- Input: `spec/probe-shelf.png` (synthetic shelf, ground-truth count 6).
- Output: `spec/probe-response-redacted.json` — record kinds, objectIds,
  and bounds only. Mask rasters are deliberately omitted.
- Exit 0 = gate reproduced (outcome `completed` + boxes found).
  Anything else = gate NOT reproduced; stop and report.
