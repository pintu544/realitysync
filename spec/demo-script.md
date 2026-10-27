# RealitySync AI — demo video script (Slice 7, S7.3)

**Pintu records this — this file is the script + shot list, not a recording.**
Target length: ~2:30. Record against the deployed URL once it is live; if
the deploy is still blocked on the day, record against the local dev server
and say so on camera — the fallback captures in
`spec/demo-captures/CAPTURES.md` exist for exactly that case.

**Demo material (verified, do not substitute blindly):**
- Shelf image: `spec/demo-shelf-9.png` — probe-style labeled shelf, 9 boxes
  (5 top + 4 bottom). Verified live 2026-10-27: SAM 9/9, coverage full.
- Shelf record: A-01 / BOX-RED, ERP expected 12 → visible 9, difference −3.
- This is a SYNTHETIC fixture, not a real warehouse photo. Say that on
  camera (see the honesty lines below) — never present it as a real shelf.

## Script

### 0:00–0:20 — Problem
> "Warehouse counts drift from ERP records all the time. A recount is slow,
> and a wrong correction is worse than no correction — it writes a guess
> into the system of record. RealitySync gives ERP systems eyes, but keeps
> the human in charge of every change."

Shot: the app homepage / inventory table (A-01, BOX-RED, expected 12).

### 0:20–0:50 — Sees
> "I upload a shelf photo. SAM 3.1, Meta's segmentation model, counts what
> it can actually see — nine cartons here, each with a numbered outline.
> Nothing hidden is counted, nothing is guessed."

Shot: upload `spec/demo-shelf-9.png` → analysis completes → 9 numbered
outlines over the boxes. Pause on the outlines so the viewer can count
along. (If the count comes back different on the day, do NOT re-record
around it — show the recount/needs-review path instead; a wrong count
hidden from the demo is worse than a live miss.)

### 0:50–1:15 — Discrepancy
> "The record says twelve. The camera sees nine. That minus-three is
> computed by code from the two numbers — the model never touches it.
> Because coverage is full, this is a confident visible count — but
> 'visible' is the key word. The camera cannot see what is occluded."

Shot: comparison panel — ERP expected 12, visible 9, difference −3,
coverage full. Point at the "computed by code" label.

### 1:15–1:50 — Investigates
> "Muse Spark investigates from the evidence only — the counts, the
> coverage, the boxes. And here is the part I am proudest of: it says
> what it does not know. True stock and the reason for the difference are
> unknown. It recommends investigating further. It invents no cause, and
> it proposes no quantity."

Shot: AI investigation panel — read the UNKNOWN line aloud, show
"Recommended next step: Investigate further" and the safe_to_auto_update
note ("a human approval is the only path to a correction").

### 1:50–2:15 — Human acts
> "So a human checks. A recount confirms nine. I approve nine — and only
> now does the record change, from twelve to nine, with the original
> evidence preserved. The decision is a new fact, not an edit of the
> evidence. If the recount had disagreed, I would reject with a reason
> and nothing would change."

Shot: approval panel → enter 9 → Approve → inventory 12 → 9, version
bump; show the approval note and the preserved original snapshot. (Do not
re-approve the same case on camera — a decided case is immutable, and
re-investigating it returns the record unchanged by design.)

### 2:15–2:30 — Metrics + close
> "Across our synthetic evaluation set, exact-confident accuracy is five
> of nineteen — and I am showing you the misses too, including one case
> where the model confidently counted three boxes for six. These are
> synthetic fixtures, not real warehouse accuracy — real-shelf evaluation
> is the next step. RealitySync does not replace the recount. It makes
> the recount happen where it matters, with evidence attached."

Shot: metrics section, including the amber caveat box. End card: repo
link + "Built for the Meta Global AI Developer Hackathon, Indie track."

## Do-not-say list (honesty guardrails)

- Do NOT call the demo shelf a real warehouse photo — it is synthetic.
- Do NOT call any synthetic number real-shelf accuracy.
- Do NOT say "proof of stock" — say "what SAM saw in this photo".
- Do NOT claim automatic ERP updates — there is no auto-update path;
  approval is human-only and safe_to_auto_update is always false.
- Do NOT claim video overlays — video scans show a count, not outlines.
- Do NOT hide a miss: if SAM miscounts during recording, show the
  needs-review/recount path instead of cutting around it.

## Shot list (checklist for the recording session)

- [ ] Inventory table (A-01 / BOX-RED / 12) in frame.
- [ ] Upload of `spec/demo-shelf-9.png`, analysis completing.
- [ ] Numbered outlines visible and countable (pause 2 s).
- [ ] Comparison panel: 12 / 9 / −3, coverage full.
- [ ] Investigation panel: UNKNOWN line + recommended action + no-auto-update note.
- [ ] Approval: enter 9, approve, inventory 12 → 9, snapshot preserved.
- [ ] Metrics section with the caveat box visible.
- [ ] End card with repo link.
