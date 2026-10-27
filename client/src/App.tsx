import { useCallback, useEffect, useRef, useState } from "react";

interface InventoryRow {
  id: string;
  sku: string;
  shelf_id: string;
  expected_qty: number;
  version: number;
}

interface DetectionBox {
  objectId: number | string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface VideoStats {
  framesWithBoxes: number;
  maxFrame: number;
  uniqueObjects: number;
}

interface Detections {
  boxes: DetectionBox[] | null;
  mask_count: number | null;
  latency_ms: number | null;
  error: string | null;
  analyzed_at: string | null;
  raw_box_count: number | null;
  video_stats: VideoStats | null;
}

interface InvestigationView {
  summary: string;
  findings: string[];
  recommended_action: string;
  needs_review: boolean;
}

interface AuditCaseView {
  id: string;
  recommendation: {
    deterministic?: { expected_qty: number; visible_qty: number; difference: number };
    investigation?: InvestigationView | null;
    investigation_error?: string | null;
    note?: string | null;
    safe_to_auto_update?: boolean;
    needs_review?: boolean;
  } | null;
  state: string;
  approved_qty: number | null;
  inventory_version: number | null;
  reject_reason: string | null;
}

interface MetricsEvalCase {
  file: string;
  kind: string;
  truth: number | null;
  uncertain: boolean;
  status: string;
  visible: number | null;
  coverage: string | null;
  needs_review: boolean | null;
  latency_ms: number | null;
  case_state: string | null;
  investigation_action: string | null;
}

interface MetricsView {
  live: {
    scansByStatusCoverage: Array<{ status: string; coverage_status: string; n: number }>;
    casesByState: Array<{ state: string; n: number }>;
    avgLatencyMs: number | null;
    analyzedScans: number;
    videoScans: number;
  };
  evalRun: {
    run: { date: string; label: string; note: string; n: number };
    metrics: {
      analyzed: number;
      failed: number;
      exactConfident: { hit: number; of: number };
      countMatch: { hit: number; of: number };
      uncertainFlagRecall: { hit: number; of: number };
      confidentWrong: { hit: number; of: number; files: string[] };
      avgLatencyMs: { image: number | null; video: number | null };
      caseCreationRate: { hit: number; of: number };
      videoCaseLive: { hit: number; of: number };
      investigationActions: Record<string, number>;
    };
    cases: MetricsEvalCase[];
  } | null;
}

interface ScanRow {
  id: string;
  media_url: string;
  visible_qty: number | null;
  coverage_status: string;
  status: string;
  created_at: string;
  shelf_id: string;
  sku: string;
  expected_qty: number;
  detections: Detections | null;
  needs_review: boolean;
  audit_case: AuditCaseView | null;
}

const ACTION_LABELS: Record<string, string> = {
  recount: "Recount the shelf",
  clearer_photo: "Take a clearer photo",
  accept_visible_for_review: "Accept the visible count for review",
  investigate_further: "Investigate further",
  no_action: "No action needed",
};

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

// Renders a scan image with SAM detection boxes drawn over it. SAM boxes
// are absolute pixels in the ORIGINAL image, so the overlay is positioned
// from the image's displayed rect (object-contain letterboxing accounted
// for) — never from the element box alone, which would drift whenever the
// rendered image does not fill its box exactly.
function ScanMedia({ scan }: { scan: ScanRow }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number; scale: number } | null>(null);

  const updateRect = useCallback(() => {
    const img = imgRef.current;
    const cont = containerRef.current;
    if (!img || !cont || !img.naturalWidth || !img.naturalHeight) return;
    const box = img.getBoundingClientRect();
    const contBox = cont.getBoundingClientRect();
    const scale = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight);
    const dw = img.naturalWidth * scale;
    const dh = img.naturalHeight * scale;
    setRect({
      x: box.left - contBox.left + (box.width - dw) / 2,
      y: box.top - contBox.top + (box.height - dh) / 2,
      w: dw,
      h: dh,
      scale,
    });
  }, []);

  useEffect(() => {
    setRect(null);
    updateRect();
    window.addEventListener("resize", updateRect);
    return () => window.removeEventListener("resize", updateRect);
  }, [updateRect, scan.id, scan.media_url]);

  if (scan.media_url.match(/\.mp4$/i)) {
    return (
      <div>
        <video src={scan.media_url} controls className="max-h-80 w-full bg-slate-200 object-contain" />
        {scan.status === "analyzed" && scan.coverage_status === "unknown" && (scan.visible_qty ?? 0) === 0 && (
          <p className="mt-2 text-xs text-slate-600">
            No objects were tracked in this video. In our test clips,
            static shots returned no detections — re-record with a slow
            pan past the shelf instead of a static shot. This is not
            evidence the shelf is empty.
          </p>
        )}
      </div>
    );
  }

  const boxes = scan.status === "analyzed" ? (scan.detections?.boxes ?? []) : [];
  return (
    <div ref={containerRef} className="relative w-full">
      <img
        ref={imgRef}
        src={scan.media_url}
        alt={`Shelf scan ${scan.shelf_id}`}
        onLoad={updateRect}
        className="max-h-80 w-full bg-slate-200 object-contain"
      />
      {rect && boxes.length > 0 && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute"
          style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
        >
          {boxes.map((b, i) => (
            <div
              key={`${b.objectId}-${i}`}
              className="absolute border-[3px] border-amber-500"
              style={{
                left: b.left * rect.scale,
                top: b.top * rect.scale,
                width: (b.right - b.left) * rect.scale,
                height: (b.bottom - b.top) * rect.scale,
              }}
            >
              <span className="absolute left-1 top-1 bg-amber-400 px-1.5 py-0.5 text-xs font-bold text-slate-900">
                {i + 1}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [inventory, setInventory] = useState<InventoryRow[]>([]);
  const [scans, setScans] = useState<ScanRow[]>([]);
  const [shelfId, setShelfId] = useState("A-01");
  const [file, setFile] = useState<File | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [pollTimedOut, setPollTimedOut] = useState(false);
  // Slice 4 QA W5: bumping this restarts the poll effect after a retry.
  // Without it, retry hid the banner without resuming polling, leaving a
  // stuck-pending scan with no auto-update and no manual control.
  const [pollCycle, setPollCycle] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Slice 6 approval panel state: the quantity input defaults to the
  // visible count but is the human's verified judgment, not the model's.
  const [approveQty, setApproveQty] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [deciding, setDeciding] = useState(false);
  const [metrics, setMetrics] = useState<MetricsView | null>(null);

  const refresh = useCallback(async () => {
    const [inv, history] = await Promise.all([
      fetchJson<InventoryRow[]>("/api/inventory"),
      fetchJson<ScanRow[]>("/api/scans"),
    ]);
    setInventory(inv);
    setScans(history);
  }, []);

  useEffect(() => {
    refresh()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
    // Metrics are display-only (live aggregates + the last labeled eval
    // run); a failure here never blocks the core screen.
    fetchJson<MetricsView>("/api/metrics")
      .then(setMetrics)
      .catch(() => {});
  }, [refresh]);

  const selected = scans.find((s) => s.id === selectedId) ?? scans[0] ?? null;

  // Reset the approval inputs whenever the selected scan changes, so the
  // quantity input always defaults to THIS scan's visible count.
  useEffect(() => {
    setApproveQty(selected?.visible_qty != null ? String(selected.visible_qty) : "");
    setRejectReason("");
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll a scan while it is pending: analysis runs in the
  // background on the server, and the row updates itself when done.
  // Video scans poll the same way since Slice 4 video tracking.
  // W5: if the 90s poll cap passes with the scan still pending, stop
  // silently polling and show the retry/refresh control instead — a
  // stuck-pending scan must be recoverable from the UI, not just by
  // reloading the page.
  useEffect(() => {
    if (!selected || selected.status !== "pending") return;
    let stopped = false;
    const started = Date.now();
    setPollTimedOut(false);
    const tick = async () => {
      if (stopped) return;
      if (Date.now() - started > 90000) {
        stopped = true;
        setPollTimedOut(true);
        return;
      }
      try {
        const detail = await fetchJson<ScanRow>(`/api/scans/${selected.id}`);
        setScans((prev) => prev.map((s) => (s.id === detail.id ? detail : s)));
        if (detail.status !== "pending") stopped = true;
      } catch {
        // Keep polling until the timeout; a transient failure is not a
        // scan failure.
      }
    };
    const timer = setInterval(tick, 2000);
    void tick();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [selected?.id, selected?.status, pollCycle]);
  // Footnote source: the selected scan's own shelf record, not the upload
  // dropdown (I4) — the two can differ once a scan from another shelf is picked.
  const selectedInventory = inventory.find((i) => i.shelf_id === selected?.shelf_id) ?? null;

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setError("Choose a shelf photo (PNG/JPG) or short video (MP4) first.");
      return;
    }
    setError(null);
    setNotice(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.append("media", file);
      form.append("shelfId", shelfId);
      const res = await fetch("/api/scans", { method: "POST", body: form });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Upload failed (${res.status})`);
      }
      const created = (await res.json()) as { scanId: string };
      await refresh();
      setSelectedId(created.scanId);
      setNotice(
        "Scan created. Analysis runs in the background — this scan updates automatically when it finishes.",
      );
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Upload failed. Check the file and try again.");
    } finally {
      setUploading(false);
    }
  }

  // Slice 6 decision: approve a human-entered corrected quantity, or
  // reject with a reason. The server enforces the version guard and
  // atomicity; here we only surface its verdicts (including the stale
  // versions, which fetchJson would otherwise drop).
  async function decide(action: "approve" | "reject") {
    if (!selected?.audit_case) return;
    if (action === "approve" && approveQty.trim() === "") {
      setError("Enter a corrected quantity before approving.");
      return;
    }
    setError(null);
    setDeciding(true);
    try {
      const body =
        action === "approve" ? { approvedQty: Number(approveQty) } : { reason: rejectReason };
      const res = await fetch(`/api/audits/${selected.audit_case.id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail =
          data.recordedVersion !== undefined
            ? ` (recorded version ${data.recordedVersion}, current version ${data.currentVersion})`
            : "";
        throw new Error(`${data.error ?? `Decision failed (${res.status})`}${detail}`);
      }
      await refresh();
      fetchJson<MetricsView>("/api/metrics")
        .then(setMetrics)
        .catch(() => {});
      setNotice(
        action === "approve"
          ? "Correction approved — simulated ERP record updated."
          : "Case rejected — inventory untouched.",
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Decision failed.");
    } finally {
      setDeciding(false);
    }
  }

  return (
    <main className="min-h-screen bg-stone-100 text-slate-900">
      <header className="border-b border-slate-300 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-baseline gap-x-4 gap-y-1 px-6 py-5">
          <h1 className="text-2xl font-bold tracking-tight">RealitySync AI</h1>
          <p className="text-sm text-slate-600">Giving ERP systems eyes — visible count vs ERP record, human-approved.</p>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-6 py-6">
        {loading && <p className="text-slate-600">Loading inventory and scan history…</p>}

        {error && (
          <div role="alert" className="mb-5 border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
            {error}{" "}
            <button
              type="button"
              className="ml-2 font-semibold underline"
              onClick={() => {
                setError(null);
                setLoading(true);
                refresh()
                  .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load"))
                  .finally(() => setLoading(false));
              }}
            >
              Retry
            </button>
          </div>
        )}
        {notice && (
          <div role="status" className="mb-5 border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
            {notice}
          </div>
        )}

        {!loading && (
          <>
            <section aria-label="Inventory" className="mb-6">
              <h2 className="mb-2 text-lg font-semibold">Simulated ERP inventory</h2>
              {inventory.length === 0 ? (
                <p className="text-sm text-slate-600">No inventory records yet. Start the server to seed the demo shelf.</p>
              ) : (
                <table className="w-full border-collapse bg-white text-left text-sm shadow-sm">
                  <thead>
                    <tr className="border-b border-slate-300">
                      <th className="px-4 py-2 font-semibold">Shelf</th>
                      <th className="px-4 py-2 font-semibold">SKU</th>
                      <th className="px-4 py-2 font-semibold tabular-nums">Expected qty</th>
                      <th className="px-4 py-2 font-semibold tabular-nums">Version</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inventory.map((row) => (
                      <tr key={row.id} className="border-b border-slate-200 last:border-0">
                        <td className="px-4 py-2">{row.shelf_id}</td>
                        <td className="px-4 py-2">{row.sku}</td>
                        <td className="px-4 py-2 tabular-nums">{row.expected_qty}</td>
                        <td className="px-4 py-2 tabular-nums">{row.version}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <div className="grid gap-6 lg:grid-cols-2">
              <section aria-label="Upload and inspect media" className="bg-white p-5 shadow-sm">
                <h2 className="mb-1 text-lg font-semibold">Scan a shelf</h2>
                <p className="mb-4 text-sm text-slate-600">
                  Upload a shelf photo or a 10–15 second video. Scans analyze
                  in the background after upload; for video, a slow pan past
                  the shelf tracks best — in our test clips, fully static
                  shots returned no detections.
                </p>
                <form onSubmit={handleUpload} className="space-y-4">
                  <div>
                    <label htmlFor="shelf" className="mb-1 block text-sm font-medium">Shelf</label>
                    <select
                      id="shelf"
                      value={shelfId}
                      onChange={(e) => setShelfId(e.target.value)}
                      className="w-full border border-slate-400 bg-white px-3 py-2 text-sm"
                    >
                      {inventory.map((row) => (
                        <option key={row.id} value={row.shelf_id}>
                          {row.shelf_id} — {row.sku}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="media" className="mb-1 block text-sm font-medium">Shelf photo or video</label>
                    <input
                      ref={fileRef}
                      id="media"
                      type="file"
                      accept="image/png,image/jpeg,video/mp4"
                      onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                      className="w-full text-sm"
                    />
                    {file && <p className="mt-1 text-sm text-slate-600">{file.name}</p>}
                  </div>
                  <button
                    type="submit"
                    disabled={uploading || inventory.length === 0}
                    className="bg-slate-900 px-5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
                  >
                    {uploading ? "Uploading…" : "Create scan"}
                  </button>
                </form>

                {selected && (
                  <div className="mt-6 border-t border-slate-200 pt-4">
                    <h3 className="mb-2 text-sm font-semibold">Selected scan media</h3>
                    <ScanMedia scan={selected} />
                    <p className="mt-2 text-xs text-slate-500">
                      Scan {selected.id} · {formatTime(selected.created_at)}
                    </p>
                    {selected.status === "analyzed" &&
                      !selected.media_url.match(/\.mp4$/i) &&
                      (selected.detections?.boxes?.length ?? 0) > 0 && (
                      <p className="mt-1 text-xs text-slate-600">
                        Numbered outlines are SAM 3.1 detections on this image — one outline
                        per visible object counted.
                      </p>
                    )}
                    {selected.status === "failed" && (
                      <div className="mt-3 border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">
                        Analysis failed: {selected.detections?.error ?? "unknown error"}. No count
                        was fabricated — retry to run detection again.
                        <button
                          type="button"
                          className="ml-2 font-semibold underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
                          onClick={async () => {
                            setError(null);
                            try {
                              const res = await fetch(`/api/scans/${selected.id}/analyze`, { method: "POST" });
                              if (!res.ok) {
                                const body = await res.json().catch(() => ({}));
                                throw new Error((body as { error?: string }).error ?? `Retry failed (${res.status})`);
                              }
                              await refresh();
                              setNotice("Analysis restarted — this scan updates automatically when it finishes.");
                            } catch (err: unknown) {
                              setError(err instanceof Error ? err.message : "Retry failed.");
                            }
                          }}
                        >
                          Retry analysis
                        </button>
                      </div>
                    )}
                    {selected.status === "pending" && pollTimedOut && (
                      <div className="mt-3 border border-amber-500 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                        Still waiting after 90 seconds — this scan may be stuck.
                        Refresh its status, or retry analysis (a run already in
                        progress answers 409 instead of double-charging).
                        <button
                          type="button"
                          className="ml-2 font-semibold underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
                          onClick={async () => {
                            setError(null);
                            try {
                              const detail = await fetchJson<ScanRow>(`/api/scans/${selected.id}`);
                              setScans((prev) => prev.map((s) => (s.id === detail.id ? detail : s)));
                              if (detail.status !== "pending") setPollTimedOut(false);
                              else setNotice("Still pending — try retrying analysis.");
                            } catch (err: unknown) {
                              setError(err instanceof Error ? err.message : "Refresh failed.");
                            }
                          }}
                        >
                          Refresh status
                        </button>
                        <button
                          type="button"
                          className="ml-2 font-semibold underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
                          onClick={async () => {
                            setError(null);
                            try {
                              const res = await fetch(`/api/scans/${selected.id}/analyze`, { method: "POST" });
                              if (!res.ok) {
                                // S5.0: a 409 means a run is already in
                                // flight — restart polling instead of
                                // stranding the user on manual Refresh:
                                // the effect re-runs on pollCycle with a
                                // fresh 90s window and picks up the
                                // finished scan on its own.
                                if (res.status === 409) {
                                  await refresh();
                                  setPollCycle((c) => c + 1);
                                  setNotice("Analysis already running — this scan updates automatically when it finishes.");
                                  return;
                                }
                                const body = await res.json().catch(() => ({}));
                                throw new Error((body as { error?: string }).error ?? `Retry failed (${res.status})`);
                              }
                              // W5: refresh first, then restart polling via
                              // pollCycle — the effect's stopped flag is
                              // already true and id/status are unchanged, so
                              // without the bump nothing would poll again.
                              await refresh();
                              setPollCycle((c) => c + 1);
                              setPollTimedOut(false);
                              setNotice("Analysis restarted — this scan updates automatically when it finishes.");
                            } catch (err: unknown) {
                              setError(err instanceof Error ? err.message : "Retry failed.");
                            }
                          }}
                        >
                          Retry analysis
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </section>

              <section aria-label="Comparison and investigation" className="bg-white p-5 shadow-sm">
                <h2 className="mb-4 text-lg font-semibold">Comparison</h2>
                {selected ? (
                  <dl className="space-y-3 text-sm">
                    <div className="flex justify-between gap-4 border-b border-slate-200 pb-2">
                      <dt className="text-slate-600">Shelf / SKU</dt>
                      <dd className="font-medium">{selected.shelf_id} / {selected.sku}</dd>
                    </div>
                    <div className="flex justify-between gap-4 border-b border-slate-200 pb-2">
                      <dt className="text-slate-600">ERP expected</dt>
                      <dd className="font-semibold tabular-nums">{selected.expected_qty}</dd>
                    </div>
                    <div className="flex justify-between gap-4 border-b border-slate-200 pb-2">
                      <dt className="text-slate-600">Visible count</dt>
                      <dd className="font-semibold tabular-nums">
                        {selected.visible_qty ?? "Awaiting analysis"}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4 border-b border-slate-200 pb-2">
                      <dt className="text-slate-600">Difference</dt>
                      <dd className="font-semibold tabular-nums">
                        {selected.visible_qty == null ? "—" : selected.visible_qty - selected.expected_qty}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4 border-b border-slate-200 pb-2">
                      <dt className="text-slate-600">Coverage</dt>
                      <dd className="font-medium">{selected.coverage_status}</dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-slate-600">Status</dt>
                      <dd className="font-medium">{selected.status}</dd>
                    </div>
                    {selected.detections && (
                      <>
                        <div className="flex justify-between gap-4 border-t border-slate-200 pt-2">
                          <dt className="text-slate-600">Detections</dt>
                          <dd className="font-medium tabular-nums">
                            {(selected.detections.boxes?.length ?? 0)} boxes
                            {selected.detections.mask_count != null && ` · ${selected.detections.mask_count} masks`}
                          </dd>
                        </div>
                        {selected.detections.latency_ms != null && (
                          <div className="flex justify-between gap-4 border-b border-slate-200 pb-2">
                            <dt className="text-slate-600">Analysis time</dt>
                            <dd className="font-medium tabular-nums">
                              {(selected.detections.latency_ms / 1000).toFixed(1)}s
                            </dd>
                          </div>
                        )}
                        {selected.detections.raw_box_count != null &&
                          selected.detections.raw_box_count !== (selected.detections.boxes?.length ?? 0) && (
                            <p className="text-xs text-slate-500">
                              {selected.detections.video_stats ? (
                                <>
                                  Counting note: SAM tracked{" "}
                                  {selected.detections.video_stats.uniqueObjects} objects across{" "}
                                  {selected.detections.video_stats.framesWithBoxes} frames (
                                  {selected.detections.raw_box_count} per-frame detections); the
                                  count dedupes by track ID, not by merging tape-line splits.
                                </>
                              ) : (
                                <>
                                  Counting note: SAM returned {selected.detections.raw_box_count} raw
                                  segments; {(selected.detections.boxes?.length ?? 0)} remain after
                                  merging vertical tape-line splits.
                                </>
                              )}
                            </p>
                          )}
                      </>
                    )}
                  </dl>
                ) : (
                  <p className="text-sm text-slate-600">No scans yet. Upload a shelf photo to create the first scan.</p>
                )}
                {selected?.needs_review && (
                  <div role="status" className="mt-4 border border-amber-500 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                    Needs review — coverage is {selected.coverage_status}, so this count is
                    observed, not confident. Do not correct inventory from this scan; a
                    recount or a clearer {selected.media_url.match(/\.mp4$/i) ? "clip" : "photo"}{" "}
                    is the safe next step.
                  </div>
                )}
                {selected && selected.status === "analyzed" && !selected.needs_review && (
                  <p className="mt-4 text-sm text-slate-600">
                    Full coverage — this is what SAM saw in this{" "}
                    {selected.media_url.match(/\.mp4$/i) ? "clip" : "photo"}: a visible
                    count, not proof of stock. A recount or a clearer photo is
                    still the safe check before any inventory change.
                  </p>
                )}
                <h3 className="mb-1 mt-6 text-sm font-semibold">AI investigation</h3>
                {!selected || selected.status === "pending" ? (
                  <p className="text-sm text-slate-600">
                    Muse Spark investigates the discrepancy from structured evidence only,
                    once analysis completes. Nothing here is model output yet.
                  </p>
                ) : selected.status === "failed" ? (
                  <p className="text-sm text-slate-600">
                    No investigation: analysis failed, so there is no evidence to investigate.
                    Retry analysis first.
                  </p>
                ) : !selected.audit_case ? (
                  <p className="text-sm text-slate-600">
                    Investigation in progress — the audit case appears here when it is ready.
                  </p>
                ) : selected.audit_case.recommendation?.investigation ? (
                  <div className="text-sm">
                    <p className="text-xs text-slate-500">
                      Investigation input, computed by code — not by the model: ERP{" "}
                      {selected.audit_case.recommendation.deterministic?.expected_qty}, visible{" "}
                      {selected.audit_case.recommendation.deterministic?.visible_qty}, difference{" "}
                      {selected.audit_case.recommendation.deterministic?.difference}, coverage{" "}
                      {selected.coverage_status}.
                    </p>
                    <p className="mt-2">{selected.audit_case.recommendation.investigation.summary}</p>
                    {selected.audit_case.recommendation.investigation.findings.length > 0 && (
                      <ul className="mt-2 list-disc space-y-1 pl-5">
                        {selected.audit_case.recommendation.investigation.findings.map((f, i) => (
                          <li key={i}>{f}</li>
                        ))}
                      </ul>
                    )}
                    <p className="mt-2 font-medium">
                      Recommended next step:{" "}
                      {ACTION_LABELS[selected.audit_case.recommendation.investigation.recommended_action] ??
                        selected.audit_case.recommendation.investigation.recommended_action}
                    </p>
                    <p className="mt-2 text-xs text-slate-500">
                      Model output, grounded in the evidence above — it recommends, it never
                      changes inventory. No automatic update will happen
                      (safe_to_auto_update is false); a human approval is the only path to
                      a correction.
                    </p>
                  </div>
                ) : selected.audit_case.recommendation?.note ? (
                  <p className="text-sm text-slate-600">{selected.audit_case.recommendation.note}</p>
                ) : (
                  <div className="text-sm">
                    <p className="text-slate-600">
                      Investigation unavailable:{" "}
                      {selected.audit_case.recommendation?.investigation_error ?? "unknown error"}.
                      No explanation was fabricated — the case stays open for review.
                    </p>
                    <button
                      type="button"
                      className="mt-2 font-semibold underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
                      onClick={async () => {
                        setError(null);
                        try {
                          const res = await fetch(`/api/scans/${selected.id}/investigate`, { method: "POST" });
                          if (!res.ok) {
                            const body = await res.json().catch(() => ({}));
                            throw new Error((body as { error?: string }).error ?? `Investigation failed (${res.status})`);
                          }
                          await refresh();
                          setNotice("Investigation updated.");
                        } catch (err: unknown) {
                          setError(err instanceof Error ? err.message : "Investigation failed.");
                        }
                      }}
                    >
                      Retry investigation
                    </button>
                  </div>
                )}
                {selected?.audit_case && selected.audit_case.state === "needs_review" && (
                  <div className="mt-6 border-t border-slate-200 pt-4">
                    <h3 className="mb-1 text-sm font-semibold">Human approval</h3>
                    <p className="mb-3 text-sm text-slate-600">
                      Approving sets the simulated ERP expected quantity for shelf{" "}
                      {selected.shelf_id} from {selected.expected_qty} to the quantity below.
                      This changes the simulated record only — not true stock. Only approve
                      a number you verified by recount; the model never proposes a quantity.
                    </p>
                    <div className="flex flex-wrap items-end gap-3">
                      <div>
                        <label htmlFor="approve-qty" className="mb-1 block text-sm font-medium">
                          Corrected quantity
                        </label>
                        <input
                          id="approve-qty"
                          type="number"
                          min={0}
                          step={1}
                          value={approveQty}
                          onChange={(e) => setApproveQty(e.target.value)}
                          className="w-32 border border-slate-400 bg-white px-3 py-2 text-sm tabular-nums"
                        />
                      </div>
                      <button
                        type="button"
                        disabled={deciding}
                        onClick={() => decide("approve")}
                        className="bg-slate-900 px-5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
                      >
                        Approve correction
                      </button>
                    </div>
                    <div className="mt-3 flex flex-wrap items-end gap-3">
                      <div>
                        <label htmlFor="reject-reason" className="mb-1 block text-sm font-medium">
                          Rejection reason
                        </label>
                        <input
                          id="reject-reason"
                          type="text"
                          value={rejectReason}
                          onChange={(e) => setRejectReason(e.target.value)}
                          placeholder="Why this case is rejected"
                          className="w-64 border border-slate-400 bg-white px-3 py-2 text-sm placeholder:text-slate-500"
                        />
                      </div>
                      <button
                        type="button"
                        disabled={deciding}
                        onClick={() => decide("reject")}
                        className="border border-slate-400 bg-white px-5 py-2 text-sm font-semibold text-slate-900 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
                      >
                        Reject case
                      </button>
                    </div>
                  </div>
                )}
                {selected?.audit_case && selected.audit_case.state === "approved" && (
                  <p className="mt-6 border-t border-slate-200 pt-4 text-sm">
                    Approved: expected quantity set to {selected.audit_case.approved_qty} (was{" "}
                    {selected.audit_case.recommendation?.deterministic?.expected_qty}). The case
                    snapshot above still shows the original numbers — the decision is a new
                    fact, not an edit of the evidence.
                  </p>
                )}
                {selected?.audit_case && selected.audit_case.state === "rejected" && (
                  <p className="mt-6 border-t border-slate-200 pt-4 text-sm">
                    Rejected: {selected.audit_case.reject_reason ?? "no reason recorded"}.
                    Inventory untouched.
                  </p>
                )}
                {selectedInventory && selected && (
                  <p className="mt-4 text-xs text-slate-500">
                    Expected quantity above comes from the simulated ERP record for shelf{" "}
                    {selectedInventory.shelf_id} (version {selectedInventory.version}).
                  </p>
                )}
              </section>
            </div>

            <section aria-label="Scan history and audit" className="mt-6 bg-white p-5 shadow-sm">
              <h2 className="mb-1 text-lg font-semibold">Scan history</h2>
              <p className="mb-4 text-sm text-slate-600">
                Select a scan to inspect its media, comparison, and audit case. Approve or
                reject a case from its comparison panel; every decision is recorded as an
                audit event.
              </p>
              {scans.length === 0 ? (
                <p className="text-sm text-slate-600">No scans yet.</p>
              ) : (
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-300">
                      <th className="px-3 py-2 font-semibold">Shelf</th>
                      <th className="px-3 py-2 font-semibold">Created</th>
                      <th className="px-3 py-2 font-semibold">Status</th>
                      <th className="px-3 py-2 font-semibold">Coverage</th>
                      <th className="px-3 py-2 font-semibold">Review</th>
                      <th className="px-3 py-2 font-semibold">Case</th>
                      <th className="px-3 py-2 font-semibold tabular-nums">Visible</th>
                      <th className="px-3 py-2 font-semibold tabular-nums">Expected</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scans.map((scan) => (
                      <tr
                        key={scan.id}
                        onClick={() => setSelectedId(scan.id)}
                        className={`cursor-pointer border-b border-slate-200 last:border-0 ${scan.id === selected?.id ? "bg-amber-50" : "hover:bg-stone-50"}`}
                      >
                        <td className="px-3 py-2">{scan.shelf_id}</td>
                        <td className="px-3 py-2">{formatTime(scan.created_at)}</td>
                        <td className="px-3 py-2">{scan.status}</td>
                        <td className="px-3 py-2">{scan.coverage_status}</td>
                        <td className="px-3 py-2">{scan.needs_review ? "Needs review" : "—"}</td>
                        <td className="px-3 py-2">{scan.audit_case ? scan.audit_case.state : "—"}</td>
                        <td className="px-3 py-2 tabular-nums">{scan.visible_qty ?? "—"}</td>
                        <td className="px-3 py-2 tabular-nums">{scan.expected_qty}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section aria-label="Evaluation metrics" className="mt-6 bg-white p-5 shadow-sm">
              <h2 className="mb-1 text-lg font-semibold">Evaluation metrics</h2>
              <p className="mb-4 text-sm text-slate-600">
                Measured numbers, not asserted ones. Live aggregates come from this
                database; the evaluation run below is the last labeled harness run
                (synthetic fixtures unless its label says otherwise).
              </p>
              {metrics && (
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between gap-4 border-b border-slate-200 pb-2">
                    <dt className="text-slate-600">Scans analyzed (live)</dt>
                    <dd className="font-medium tabular-nums">{metrics.live.analyzedScans}</dd>
                  </div>
                  <div className="flex justify-between gap-4 border-b border-slate-200 pb-2">
                    <dt className="text-slate-600">Video scans (live)</dt>
                    <dd className="font-medium tabular-nums">{metrics.live.videoScans}</dd>
                  </div>
                  <div className="flex justify-between gap-4 border-b border-slate-200 pb-2">
                    <dt className="text-slate-600">Average SAM latency (live)</dt>
                    <dd className="font-medium tabular-nums">
                      {metrics.live.avgLatencyMs != null
                        ? `${(metrics.live.avgLatencyMs / 1000).toFixed(1)}s`
                        : "—"}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4 border-b border-slate-200 pb-2">
                    <dt className="text-slate-600">Cases by state (live)</dt>
                    <dd className="font-medium">
                      {metrics.live.casesByState.length > 0
                        ? metrics.live.casesByState.map((c) => `${c.state}: ${c.n}`).join(" · ")
                        : "—"}
                    </dd>
                  </div>
                </dl>
              )}
              {metrics?.evalRun ? (
                <div className="mt-5">
                  <h3 className="mb-1 text-sm font-semibold">
                    Last evaluation run — {metrics.evalRun.run.label}
                  </h3>
                  <p className="mb-3 text-xs text-slate-500">
                    {new Date(metrics.evalRun.run.date).toLocaleString()} · {metrics.evalRun.run.n}{" "}
                    scans · {metrics.evalRun.run.note}
                  </p>
                  <dl className="space-y-2 text-sm">
                    <div className="flex justify-between gap-4 border-b border-slate-200 pb-2">
                      <dt className="text-slate-600">Exact-confident accuracy</dt>
                      <dd className="font-semibold tabular-nums">
                        {metrics.evalRun.metrics.exactConfident.hit}/
                        {metrics.evalRun.metrics.exactConfident.of}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4 border-b border-slate-200 pb-2">
                      <dt className="text-slate-600">Count match (any coverage)</dt>
                      <dd className="font-medium tabular-nums">
                        {metrics.evalRun.metrics.countMatch.hit}/{metrics.evalRun.metrics.countMatch.of}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4 border-b border-slate-200 pb-2">
                      <dt className="text-slate-600">Uncertain-flag recall</dt>
                      <dd className="font-medium tabular-nums">
                        {metrics.evalRun.metrics.uncertainFlagRecall.hit}/
                        {metrics.evalRun.metrics.uncertainFlagRecall.of}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4 border-b border-slate-200 pb-2">
                      <dt className="text-slate-600">Confident-wrong (numeric truth)</dt>
                      <dd className="font-medium tabular-nums">
                        {metrics.evalRun.metrics.confidentWrong.hit}/
                        {metrics.evalRun.metrics.confidentWrong.of}
                        {metrics.evalRun.metrics.confidentWrong.files.length > 0 &&
                          ` (${metrics.evalRun.metrics.confidentWrong.files.join(", ")})`}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4 border-b border-slate-200 pb-2">
                      <dt className="text-slate-600">Cases created / analyzed</dt>
                      <dd className="font-medium tabular-nums">
                        {metrics.evalRun.metrics.caseCreationRate.hit}/
                        {metrics.evalRun.metrics.caseCreationRate.of}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-slate-600">Video scans with cases</dt>
                      <dd className="font-medium tabular-nums">
                        {metrics.evalRun.metrics.videoCaseLive.hit}/
                        {metrics.evalRun.metrics.videoCaseLive.of}
                      </dd>
                    </div>
                  </dl>
                  <table className="mt-4 w-full border-collapse text-left text-sm">
                    <thead>
                      <tr className="border-b border-slate-300">
                        <th className="px-3 py-2 font-semibold">File</th>
                        <th className="px-3 py-2 font-semibold tabular-nums">Truth</th>
                        <th className="px-3 py-2 font-semibold tabular-nums">Visible</th>
                        <th className="px-3 py-2 font-semibold">Coverage</th>
                        <th className="px-3 py-2 font-semibold">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {metrics.evalRun.cases.map((c) => {
                        const mismatch =
                          typeof c.truth === "number" && c.visible !== c.truth;
                        return (
                          <tr
                            key={c.file}
                            className={`border-b border-slate-200 last:border-0 ${mismatch ? "bg-amber-50" : ""}`}
                          >
                            <td className="px-3 py-2">{c.file}</td>
                            <td className="px-3 py-2 tabular-nums">{c.truth ?? "uncertain"}</td>
                            <td className="px-3 py-2 tabular-nums">{c.visible ?? "—"}</td>
                            <td className="px-3 py-2">{c.coverage ?? "—"}</td>
                            <td className="px-3 py-2">{c.investigation_action ?? "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="mt-4 text-sm text-slate-600">
                  No evaluation run recorded yet. Run spec/eval/run-eval-s6.mjs against a
                  dev server to generate server/eval-results.json.
                </p>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}
