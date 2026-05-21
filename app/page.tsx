"use client";

import {
  AlertTriangle,
  Archive,
  Download,
  Eye,
  FileSpreadsheet,
  HardDrive,
  RefreshCw,
  Trash2,
  Users
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatBytes, formatMoney } from "@/lib/format";

type Usage = {
  database: { used_bytes_estimate: number; limit_bytes: number };
  storage: { used_bytes: number; limit_bytes: number; file_count: number };
  events: Array<{
    event_id: string;
    event_name: string;
    event_slug: string;
    file_count: number;
    storage_bytes: number;
    review_count: number;
  }>;
};

type EventSummary = {
  id: string;
  name: string;
  slug: string;
  is_open: boolean;
  expected_total: number;
  target_count: number;
  paid_count: number;
  unpaid_count: number;
  slip_count: number;
  storage_bytes: number;
};

type EventDetail = {
  event: { id: string; name: string; slug: string; expected_total: number };
  targets: Array<{
    id: string;
    display_name: string;
    amount_due: number;
    status: string;
    paid_at: string | null;
  }>;
  slips: Array<{
    id: string;
    status: string;
    file_size: number;
    storage_path: string | null;
    file_deleted_at: string | null;
    amount_expected: number | null;
    amount_detected: number | null;
    created_at: string;
    payment_targets: { display_name: string } | null;
  }>;
};

type CleanupMode = "files" | "files_and_metadata" | "event";

function percent(used: number, limit: number) {
  return Math.min(100, Math.round((used / limit) * 100));
}

function toneClass(value: number) {
  if (value >= 95) return "danger";
  if (value >= 70) return "warn";
  return "";
}

async function api<T>(path: string, secret: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-admin-secret": secret,
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json() as Promise<T>;
}

export default function Home() {
  const [secret, setSecret] = useState("");
  const [usage, setUsage] = useState<Usage | null>(null);
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cleanup, setCleanup] = useState<{
    mode: CleanupMode;
    event: EventSummary;
  } | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem("admin-secret");
    if (saved) setSecret(saved);
  }, []);

  useEffect(() => {
    if (secret) window.localStorage.setItem("admin-secret", secret);
  }, [secret]);

  const selectedEvent = useMemo(
    () => events.find((event) => event.id === selectedEventId) ?? events[0],
    [events, selectedEventId]
  );

  async function loadAll() {
    if (!secret) return;
    setBusy(true);
    setError(null);
    try {
      const [usageData, eventsData] = await Promise.all([
        api<Usage>("/api/admin/usage", secret),
        api<{ events: EventSummary[] }>("/api/admin/events", secret)
      ]);
      setUsage(usageData);
      setEvents(eventsData.events);
      const activeId = selectedEventId ?? eventsData.events[0]?.id ?? null;
      setSelectedEventId(activeId);
      if (activeId) {
        setDetail(await api<EventDetail>(`/api/admin/events/${activeId}`, secret));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function selectEvent(eventId: string) {
    setSelectedEventId(eventId);
    setDetail(await api<EventDetail>(`/api/admin/events/${eventId}`, secret));
  }

  async function runCleanup() {
    if (!cleanup) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/admin/events/${cleanup.event.id}/cleanup`, secret, {
        method: "POST",
        body: JSON.stringify({
          mode: cleanup.mode,
          confirmName,
          reason: "Admin cleanup from dashboard"
        })
      });
      setCleanup(null);
      setConfirmName("");
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function openSlip(slipId: string) {
    const data = await api<{ signedUrl: string }>(
      `/api/admin/slips/${slipId}/signed-url`,
      secret,
      { method: "POST", body: "{}" }
    );
    setPreviewUrl(data.signedUrl);
  }

  function authenticatedDownload(url: string) {
    fetch(url, { headers: { "x-admin-secret": secret } })
      .then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = objectUrl;
        const disposition = response.headers.get("content-disposition") ?? "";
        a.download = disposition.match(/filename="([^"]+)"/)?.[1] ?? "download";
        a.click();
        URL.revokeObjectURL(objectUrl);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }

  const storagePct = usage ? percent(usage.storage.used_bytes, usage.storage.limit_bytes) : 0;
  const dbPct = usage ? percent(usage.database.used_bytes_estimate, usage.database.limit_bytes) : 0;

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <h1>LINE Slip Admin</h1>
          <p>Supabase Storage + Database usage, slip files, cleanup และรายชื่อยังไม่จ่าย</p>
        </div>
        <div className="secret">
          <input
            aria-label="Admin secret"
            placeholder="ADMIN_SHARED_SECRET"
            type="password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
          />
          <button className="btn primary" disabled={!secret || busy} onClick={loadAll}>
            <RefreshCw size={16} />
            โหลดข้อมูล
          </button>
        </div>
      </header>

      <main className="main">
        {error ? (
          <section className="panel">
            <span className="badge danger">Error</span>
            <p>{error}</p>
          </section>
        ) : null}

        <section className="grid">
          <div className="panel stat">
            <div className="panelHeader">
              <h2>Storage</h2>
              <HardDrive size={20} />
            </div>
            <strong>{usage ? formatBytes(usage.storage.used_bytes) : "-"}</strong>
            <p className="muted">
              จาก {usage ? formatBytes(usage.storage.limit_bytes) : "-"} · {usage?.storage.file_count ?? 0} ไฟล์
            </p>
            <div className={`progress ${toneClass(storagePct)}`}>
              <span style={{ width: `${storagePct}%` }} />
            </div>
            {storagePct >= 70 ? <span className="badge warn">ใกล้เต็ม {storagePct}%</span> : null}
          </div>

          <div className="panel stat">
            <div className="panelHeader">
              <h2>Database</h2>
              <Archive size={20} />
            </div>
            <strong>{usage ? formatBytes(usage.database.used_bytes_estimate) : "-"}</strong>
            <p className="muted">
              estimate จาก rows ที่ใช้ใน dashboard · limit {usage ? formatBytes(usage.database.limit_bytes) : "-"}
            </p>
            <div className={`progress ${toneClass(dbPct)}`}>
              <span style={{ width: `${dbPct}%` }} />
            </div>
            {dbPct >= 70 ? <span className="badge warn">ใกล้เต็ม {dbPct}%</span> : null}
          </div>

          <div className="panel stat">
            <div className="panelHeader">
              <h2>Top Usage</h2>
              <AlertTriangle size={20} />
            </div>
            <strong>{usage?.events[0]?.event_name ?? "-"}</strong>
            <p className="muted">
              {usage?.events[0] ? formatBytes(usage.events[0].storage_bytes) : "ยังไม่มีไฟล์"}
            </p>
          </div>
        </section>

        <section className="panel">
          <div className="panelHeader">
            <h2>งานเรียกเก็บเงิน</h2>
            <span className="badge">{events.length} งาน</span>
          </div>
          <div className="tableWrap">
            <table>
              <thead>
                <tr>
                  <th>งาน</th>
                  <th>ยอดรวม</th>
                  <th>จ่ายแล้ว</th>
                  <th>ยังไม่จ่าย</th>
                  <th>สลิป</th>
                  <th>พื้นที่</th>
                  <th>เมนู</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td>
                      <button className="btn" onClick={() => selectEvent(event.id)}>
                        {event.name}
                      </button>
                      <p className="muted">{event.slug}</p>
                    </td>
                    <td>{formatMoney(event.expected_total)}</td>
                    <td>
                      <span className="badge ok">{event.paid_count}</span>
                    </td>
                    <td>
                      <span className={event.unpaid_count ? "badge warn" : "badge ok"}>
                        {event.unpaid_count}
                      </span>
                    </td>
                    <td>{event.slip_count}</td>
                    <td>{formatBytes(event.storage_bytes)}</td>
                    <td>
                      <div className="actions">
                        <button
                          className="btn"
                          onClick={() =>
                            authenticatedDownload(`/api/admin/events/${event.id}/export.csv`)
                          }
                        >
                          <FileSpreadsheet size={15} />
                          CSV
                        </button>
                        <button
                          className="btn"
                          onClick={() =>
                            authenticatedDownload(`/api/admin/events/${event.id}/slips.zip`)
                          }
                        >
                          <Download size={15} />
                          ZIP
                        </button>
                        <button
                          className="btn danger"
                          onClick={() => setCleanup({ mode: "files", event })}
                        >
                          <Trash2 size={15} />
                          ลบรูป
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {selectedEvent && detail ? (
          <section className="detailGrid">
            <div className="panel">
              <div className="panelHeader">
                <h2>ยังไม่จ่าย · {selectedEvent.name}</h2>
                <Users size={20} />
              </div>
              <div className="tableWrap">
                <table>
                  <thead>
                    <tr>
                      <th>ชื่อ</th>
                      <th>ยอด</th>
                      <th>สถานะ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.targets
                      .filter((target) => target.status !== "verified")
                      .map((target) => (
                        <tr key={target.id}>
                          <td>{target.display_name}</td>
                          <td>{formatMoney(target.amount_due)}</td>
                          <td>
                            <span className="badge warn">{target.status}</span>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <button
                className="btn"
                onClick={() => {
                  const text = detail.targets
                    .filter((target) => target.status !== "verified")
                    .map((target) => `${target.display_name} ${formatMoney(target.amount_due)} บาท`)
                    .join("\n");
                  navigator.clipboard.writeText(text);
                }}
              >
                คัดลอกรายชื่อยังไม่จ่าย
              </button>
            </div>

            <div className="panel">
              <div className="panelHeader">
                <h2>ไฟล์สลิป</h2>
                <div className="actions">
                  <button
                    className="btn danger"
                    onClick={() => setCleanup({ mode: "files_and_metadata", event: selectedEvent })}
                  >
                    ลบรูป + metadata
                  </button>
                  <button
                    className="btn danger"
                    onClick={() => setCleanup({ mode: "event", event: selectedEvent })}
                  >
                    ปิด/ล้างงาน
                  </button>
                </div>
              </div>
              <div className="tableWrap">
                <table>
                  <thead>
                    <tr>
                      <th>ชื่อ</th>
                      <th>สถานะ</th>
                      <th>ยอด</th>
                      <th>ขนาด</th>
                      <th>วันที่</th>
                      <th>ดู</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.slips.map((slip) => (
                      <tr key={slip.id}>
                        <td>{slip.payment_targets?.display_name ?? "-"}</td>
                        <td>
                          <span className="badge">{slip.status}</span>
                        </td>
                        <td>{formatMoney(slip.amount_expected)}</td>
                        <td>{formatBytes(slip.file_size)}</td>
                        <td>{new Date(slip.created_at).toLocaleString("th-TH")}</td>
                        <td>
                          <button
                            className="btn"
                            disabled={!slip.storage_path || Boolean(slip.file_deleted_at)}
                            onClick={() => openSlip(slip.id)}
                          >
                            <Eye size={15} />
                            เปิด
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        ) : null}
      </main>

      {cleanup ? (
        <div className="modalBackdrop">
          <div className="modal">
            <h3>ยืนยันการล้างข้อมูล</h3>
            <p>
              โหมด: <strong>{cleanup.mode}</strong>
              <br />
              งาน: <strong>{cleanup.event.name}</strong>
            </p>
            <p className="muted">พิมพ์ชื่องานให้ตรงเพื่อยืนยัน การกระทำนี้จะถูกบันทึก audit log</p>
            <input
              value={confirmName}
              onChange={(event) => setConfirmName(event.target.value)}
              placeholder={cleanup.event.name}
            />
            <div className="actions">
              <button className="btn" onClick={() => setCleanup(null)}>
                ยกเลิก
              </button>
              <button
                className="btn danger"
                disabled={confirmName !== cleanup.event.name || busy}
                onClick={runCleanup}
              >
                ยืนยันลบ
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {previewUrl ? (
        <div className="modalBackdrop" onClick={() => setPreviewUrl(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="preview" src={previewUrl} alt="Slip preview" />
        </div>
      ) : null}
    </div>
  );
}
