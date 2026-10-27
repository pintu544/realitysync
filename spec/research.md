# research.md — RealitySync AI (2026-10-27)

## Blueprint source (primary)
- ChatGPT shared conversation "Hackathon Build Idea" — RealitySync AI, Hackathon Winning Blueprint. **Working link (2nd): https://chatgpt.com/share/6ae00a22-49e4-83ee-8eb2-520fa4aabb5f** (read in full via live browser 2026-10-27; 2 prompts + 2 replies, nothing cut off). **1st link is DEAD: https://chatgpt.com/share/6ae00991-652c-83ee-931a-56daf9183e03** (only its opening line was fetchable).
- Pintu's standing note (2026-10-27): this shared link stays available for review whenever the build gets stuck — re-read the blueprint before guessing.

## Blueprint facts (from the read, not independently verified)
- Event: Meta Global AI Developer Hackathon, Indie Dev Track, "Build for Your World", $1M pool; judging: creativity, technical ambition, working product.
- Window Oct 27–Nov 4, 2026; submit by Nov 4 21:00 ET = Nov 5 07:30 IST. Application deadline already passed; Pintu is an accepted participant.
- Models: sam-3.1 (segmentation/detection/tracking), muse-spark-1.3 (reasoning, structured JSON), via Meta Model API base https://api.meta.ai/v1; @meta-sam/parser (parseImageStream, parseVideoStream, recordsOfKind); Files API purpose "user_data" for MP4.
- Demo case: Shelf A-01, SKU BOX-RED, ERP 12 vs visible 9, difference −3.

## NOT verified from our side (verify before relying)
- SAM 3.1 availability/shape on Pintu's Meta key and the exact Responses API + parser usage — Slice 1 probe decides this. Do NOT trust training data; check current Meta docs via Context7 first.
- Source URLs behind the blueprint's "Meta Model API" citations were not exposed in the rendered view — listed by label only.
- Official rules, team-size rule, portal submission requirements — check the participant dashboard; nothing about them is in the blueprint.
- Credit balance / rate limits on the Meta key — probe + dashboard check.

## Standing context reused (verified earlier, Oct 26–27)
- Meta key: stored in `~/workspace/goals/meta-global-ai-developer-hackathon-entry/hidden_files/.env` as MODEL_API_KEY (600, outside any repo). Muse Spark verified live Oct 26–27 (T-1 probe + livedocs-meta production). SAM is a different model on the same API — access is the open question.
- Azure deploy pattern (proven Oct 27): F1 free, Central India, RG imp_group; app settings via `az rest` full-list PUT (az CLI appsettings fails via proxy 411; ARM GET lies, never merge from a GET); zip deploy runs no install (include node_modules when deps change).
- Deploy preference: Azure first for new things (Pintu, Oct 26).
