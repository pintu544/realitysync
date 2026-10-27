// Muse Spark investigation (Slice 5) — structured reasoning from evidence
// ONLY. The model never sees media bytes, never recomputes the
// deterministic numbers, and never proposes a corrected quantity: the
// output schema has no quantity field. Call shape mirrors the proven
// livedocs-meta client: POST {base}/chat/completions, model
// muse-spark-1.3, response_format json_object, temperature 0.3.
// The key comes from MODEL_API_KEY only and is never logged, stored,
// or returned. Provider error bodies are never surfaced (a provider
// that echoes a rejected key would leak it through logs otherwise).

export interface InvestigationEvidence {
  shelf_id: string;
  sku: string;
  expected_qty: number;
  visible_qty: number;
  difference: number;
  coverage_status: string;
  media_type: "image" | "video";
  box_count: number;
  raw_box_count: number | null;
  mask_count: number | null;
  latency_ms: number | null;
  video_stats: { framesWithBoxes: number; maxFrame: number; uniqueObjects: number } | null;
  boxes: Array<{ index: number; border_touch: boolean; confidence: number | null }>;
  // False when the media file could not be re-read for dimensions: the
  // border_touch flags above are then all false and must not be trusted.
  dimensions_known: boolean;
}

export type RecommendedAction =
  | "recount"
  | "clearer_photo"
  | "accept_visible_for_review"
  | "investigate_further"
  | "no_action";

export interface Investigation {
  summary: string;
  findings: string[];
  recommended_action: RecommendedAction;
  needs_review: boolean;
}

const RECOMMENDED_ACTIONS: RecommendedAction[] = [
  "recount",
  "clearer_photo",
  "accept_visible_for_review",
  "investigate_further",
  "no_action",
];

const SYSTEM_PROMPT = `You are the investigation assistant for a warehouse shelf audit. You do NOT know the true stock on the shelf. You know ONLY the structured evidence supplied in the user message: an ERP expected quantity, a camera-visible count produced by a segmentation model, and detection metadata. You have not seen the photo or video.

HARD RULES — violating any of these is a failure:
- Invent nothing. Do not state, imply, or guess any stock number, object count, or quantity that is not in the evidence. Do not describe objects the evidence does not list. Do not explain the discrepancy with a specific cause (theft, misplacement, data entry error, delivery) as fact — at most name causes as hypotheses, labeled as hypotheses.
- Use only the evidence. Every finding must trace to a field of the evidence envelope. If a claim cannot be traced to the envelope, do not make it.
- What you do not know, say so. True stock, occluded contents, and why the ERP record differs from the visible count are all UNKNOWN to you. Never present the visible count as true stock: it is what the camera segmentation saw, and segmentation misses objects silently.
- Unknown means needs_review. When coverage is partial or unknown, or the evidence cannot support a conclusion, set needs_review to true and recommend a safe action (recount, clearer_photo, investigate_further) — never an inventory change.
- Flag inconsistency, never smooth it over. If envelope fields disagree with each other (for example the visible count does not match the number of boxes listed), say so explicitly in your findings instead of picking a consistent story.
- You propose NO corrected quantity. Your output has no quantity field; a corrected number can only come from a human approval, never from you.
- The deterministic numbers in the envelope (expected, visible, difference) were computed by code, not by you. Do not recompute, reorder, or override them. Report them exactly as given.

Return ONLY a JSON object with exactly these fields:
- summary: one or two sentences stating what the evidence shows and what remains unknown.
- findings: an array of short evidence-grounded observations (each traceable to the envelope).
- recommended_action: exactly one of "recount", "clearer_photo", "accept_visible_for_review", "investigate_further", "no_action".
- needs_review: boolean, true unless the evidence fully supports a confident conclusion.`;

function validateInvestigation(raw: unknown): Investigation {
  if (typeof raw !== "object" || raw === null) throw new SparkParseError("investigation is not an object");
  const r = raw as Record<string, unknown>;
  if (typeof r.summary !== "string" || r.summary.trim() === "") {
    throw new SparkParseError("investigation summary missing");
  }
  if (!Array.isArray(r.findings) || !r.findings.every((f) => typeof f === "string")) {
    throw new SparkParseError("investigation findings malformed");
  }
  if (typeof r.recommended_action !== "string" || !(RECOMMENDED_ACTIONS as string[]).includes(r.recommended_action)) {
    throw new SparkParseError("investigation recommended_action invalid");
  }
  if (typeof r.needs_review !== "boolean") {
    throw new SparkParseError("investigation needs_review missing");
  }
  return {
    summary: r.summary,
    findings: r.findings as string[],
    recommended_action: r.recommended_action as RecommendedAction,
    needs_review: r.needs_review,
  };
}

export class SparkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SparkError";
  }
}

// Parse/schema failures only: a distinct class so the retry below can
// match exactly this failure kind. (Slice 6 W2: the old regex predicate
// `/valid JSON|malformed|missing|invalid/` also matched the no-key
// error "Meta API not configured (MODEL_API_KEY missing)" and fired a
// second throwaway call — harmless, no network, but a wasted attempt
// that muddied the failure. The not-configured error is a plain
// SparkError and is never retried now.)
export class SparkParseError extends SparkError {
  constructor(message: string) {
    super(message);
    this.name = "SparkParseError";
  }
}

async function callOnce(evidence: InvestigationEvidence): Promise<Investigation> {
  const key = process.env.MODEL_API_KEY ?? "";
  if (!key) throw new SparkError("Meta API not configured (MODEL_API_KEY missing)");
  const base = process.env.LLM_BASE_URL ?? "https://api.meta.ai/v1";
  const model = process.env.LLM_MODEL ?? "muse-spark-1.3";
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Investigate this shelf-scan discrepancy from the evidence only:\n\n${JSON.stringify(evidence, null, 2)}` },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
      // Reasoning tokens dominate completion tokens on muse-spark-1.3: a
      // 2000-token cap was consumed entirely by reasoning with zero
      // content tokens produced (measured 2026-10-27: 1998 reasoning /
      // 2000 total, empty content, finish_reason length). The cap must
      // leave room for reasoning AND the JSON answer.
      max_tokens: 12000,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    // Generic message only — provider bodies are never surfaced.
    throw new SparkError(`LLM request failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  };
  const text = data.choices?.[0]?.message?.content ?? "";
  // Strip markdown fences if the model wrapped its JSON in them.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    // Log a short preview server-side only (never persisted to a case or
    // returned to a client) so a repeat failure is diagnosable.
    console.error(
      `Spark JSON parse failed (finish_reason: ${data.choices?.[0]?.finish_reason ?? "unknown"}): ${candidate.slice(0, 300)}`,
    );
    throw new SparkParseError("LLM did not return valid JSON");
  }
  return validateInvestigation(parsed);
}

// One parse/schema retry, then the caller degrades fail-closed (case with
// investigation null + honest error note — never a fabricated explanation).
// Only SparkParseError retries: a completed call that returned unusable
// JSON/schema. Provider errors and the not-configured error throw at once.
export async function investigateDiscrepancy(
  evidence: InvestigationEvidence,
): Promise<{ investigation: Investigation; latencyMs: number }> {
  const started = Date.now();
  try {
    const investigation = await callOnce(evidence);
    return { investigation, latencyMs: Date.now() - started };
  } catch (err) {
    if (err instanceof SparkParseError) {
      const investigation = await callOnce(evidence);
      return { investigation, latencyMs: Date.now() - started };
    }
    throw err;
  }
}
