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
}

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
  }, [refresh]);

  const selected = scans.find((s) => s.id === selectedId) ?? scans[0] ?? null;

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
                    recount or a clearer photo is the safe next step.
                  </div>
                )}
                {selected && selected.status === "analyzed" && !selected.needs_review && (
                  <p className="mt-4 text-sm text-slate-600">
                    Full coverage — this is what SAM saw in this photo: a visible
                    count, not proof of stock. A recount or a clearer photo is
                    still the safe check before any inventory change.
                  </p>
                )}
                <h3 className="mb-1 mt-6 text-sm font-semibold">AI investigation</h3>
                <p className="text-sm text-slate-600">
                  Muse Spark investigates the discrepancy from structured evidence only.
                  That panel arrives with Slice 5; nothing here is model output yet.
                </p>
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
                Select a scan to inspect its media and comparison. Audit cases and the
                approve/reject controls arrive with Slices 5–6; no audit case exists yet.
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
                        <td className="px-3 py-2 tabular-nums">{scan.visible_qty ?? "—"}</td>
                        <td className="px-3 py-2 tabular-nums">{scan.expected_qty}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}
