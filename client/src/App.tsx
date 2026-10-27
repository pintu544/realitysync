import { useCallback, useEffect, useRef, useState } from "react";

interface InventoryRow {
  id: string;
  sku: string;
  shelf_id: string;
  expected_qty: number;
  version: number;
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

export default function App() {
  const [inventory, setInventory] = useState<InventoryRow[]>([]);
  const [scans, setScans] = useState<ScanRow[]>([]);
  const [shelfId, setShelfId] = useState("A-01");
  const [file, setFile] = useState<File | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
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
  const selectedInventory = inventory.find((i) => i.shelf_id === shelfId) ?? null;

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
      setNotice("Scan created. It stays pending until analysis runs in Slice 3.");
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
                  Upload a shelf photo or a 10–15 second video. The scan record is created
                  immediately; detection and counting arrive with Slice 3.
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
                    className="bg-slate-900 px-5 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {uploading ? "Uploading…" : "Create scan"}
                  </button>
                </form>

                {selected && (
                  <div className="mt-6 border-t border-slate-200 pt-4">
                    <h3 className="mb-2 text-sm font-semibold">Selected scan media</h3>
                    {selected.media_url.match(/\.(mp4)$/i) ? (
                      <video src={selected.media_url} controls className="max-h-80 w-full bg-slate-200 object-contain" />
                    ) : (
                      <img src={selected.media_url} alt={`Shelf scan ${selected.shelf_id}`} className="max-h-80 w-full bg-slate-200 object-contain" />
                    )}
                    <p className="mt-2 text-xs text-slate-500">
                      Scan {selected.id} · {formatTime(selected.created_at)}
                    </p>
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
                  </dl>
                ) : (
                  <p className="text-sm text-slate-600">No scans yet. Upload a shelf photo to create the first scan.</p>
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
