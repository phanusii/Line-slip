"use client";

import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Clock3,
  Download,
  Eye,
  FileSpreadsheet,
  HardDrive,
  LogOut,
  Mail,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Users
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatBytes, formatMoney } from "@/lib/format";
import { statusLabels } from "@/lib/status";
import { RichMenuBuilder } from "@/components/RichMenuBuilder";

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

const exampleTargetsText = `สมชาย\t500
สมหญิง\t500
มานะ\t500`;

const cleanupModeLabels: Record<CleanupMode, string> = {
  files: "ลบเฉพาะรูปสลิป",
  files_and_metadata: "ลบรูปและข้อมูลสลิป",
  event: "ปิดงานและล้างข้อมูล"
};

function percent(used: number, limit: number) {
  return Math.min(100, Math.round((used / limit) * 100));
}

function toneClass(value: number) {
  if (value >= 95) return "danger";
  if (value >= 70) return "warn";
  return "";
}

type AuthUser = {
  email: string;
  role: "admin" | "viewer";
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      message = parsed.error ?? text;
    } catch {
      message = text.startsWith("{") ? "เกิดข้อผิดพลาดในการเชื่อมต่อระบบ" : text;
    }
    throw new Error(message || "เกิดข้อผิดพลาดในการเชื่อมต่อระบบ");
  }

  return response.json() as Promise<T>;
}

export default function Home() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [adminUser, setAdminUser] = useState<AuthUser | null>(null);
  const [authChecking, setAuthChecking] = useState(true);
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
  const [targetFilter, setTargetFilter] = useState("unpaid");
  const [slipFilter, setSlipFilter] = useState("all");
  const [activePage, setActivePage] = useState("overview");
  const [origin, setOrigin] = useState("");
  const [confirmName, setConfirmName] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [createEventOpen, setCreateEventOpen] = useState(false);
  const [newEventName, setNewEventName] = useState("");
  const [newPromptpayId, setNewPromptpayId] = useState("");
  const [newDefaultAmount, setNewDefaultAmount] = useState("");
  const [newTargetsText, setNewTargetsText] = useState(exampleTargetsText);

  useEffect(() => {
    setOrigin(window.location.origin);
    void checkSession();
  }, []);

  const selectedEvent = useMemo(
    () => events.find((event) => event.id === selectedEventId) ?? events[0],
    [events, selectedEventId]
  );

  async function checkSession() {
    setAuthChecking(true);
    try {
      const response = await fetch("/api/admin/session", { credentials: "include" });
      if (!response.ok) return;
      const data = (await response.json()) as { user: AuthUser };
      setAdminUser(data.user);
      await loadAll(true);
    } catch {
      setAdminUser(null);
    } finally {
      setAuthChecking(false);
    }
  }

  async function loginAdmin() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/login", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      const data = (await response.json()) as { user?: AuthUser; error?: string };
      if (!response.ok) throw new Error(data.error ?? "เข้าสู่ระบบไม่สำเร็จ");
      setAdminUser(data.user ?? null);
      setPassword("");
      await loadAll(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function logoutAdmin() {
    await fetch("/api/admin/logout", { method: "POST", credentials: "include" });
    setAdminUser(null);
    setUsage(null);
    setEvents([]);
    setDetail(null);
    setSelectedEventId(null);
    setPassword("");
  }

  async function loadAll(force = false) {
    if (!force && !adminUser) return;
    setBusy(true);
    setError(null);
    try {
      const [usageData, eventsData] = await Promise.all([
        api<Usage>("/api/admin/usage"),
        api<{ events: EventSummary[] }>("/api/admin/events")
      ]);
      setUsage(usageData);
      setEvents(eventsData.events);
      const activeId = selectedEventId ?? eventsData.events[0]?.id ?? null;
      setSelectedEventId(activeId);
      if (activeId) {
        setDetail(await api<EventDetail>(`/api/admin/events/${activeId}`));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function selectEvent(eventId: string) {
    setSelectedEventId(eventId);
    setError(null);
    try {
      setDetail(await api<EventDetail>(`/api/admin/events/${eventId}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function runCleanup() {
    if (!cleanup) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/admin/events/${cleanup.event.id}/cleanup`, {
        method: "POST",
        body: JSON.stringify({
          mode: cleanup.mode,
          confirmName,
          reason: "ล้างข้อมูลจากแดชบอร์ดผู้ดูแล"
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
      { method: "POST", body: "{}" }
    );
    setPreviewUrl(data.signedUrl);
  }

  function authenticatedDownload(url: string) {
    fetch(url, { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = objectUrl;
        const disposition = response.headers.get("content-disposition") ?? "";
        a.download = disposition.match(/filename="([^"]+)"/)?.[1] ?? "ดาวน์โหลด";
        a.click();
        URL.revokeObjectURL(objectUrl);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }

  async function updateSlipStatus(slipId: string, status: string) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/admin/slips/${slipId}/status`, {
        method: "POST",
        body: JSON.stringify({
          status,
          reason: "ปรับสถานะจากแดชบอร์ดผู้ดูแล"
        })
      });
      if (selectedEventId) {
        setDetail(await api<EventDetail>(`/api/admin/events/${selectedEventId}`));
      }
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function createEvent() {
    setBusy(true);
    setError(null);
    try {
      const data = await api<{ event: EventSummary }>(
        "/api/admin/events",
        {
          method: "POST",
          body: JSON.stringify({
            name: newEventName,
            promptpay_id: newPromptpayId,
            default_amount: newDefaultAmount,
            targets_text: newTargetsText
          })
        }
      );
      setCreateEventOpen(false);
      setNewEventName("");
      setNewPromptpayId("");
      setNewDefaultAmount("");
      setNewTargetsText(exampleTargetsText);
      setSelectedEventId(data.event.id);
      setActivePage("events");
      await loadAll(true);
      await selectEvent(data.event.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const storagePct = usage ? percent(usage.storage.used_bytes, usage.storage.limit_bytes) : 0;
  const dbPct = usage ? percent(usage.database.used_bytes_estimate, usage.database.limit_bytes) : 0;
  const paidCount = events.reduce((sum, event) => sum + event.paid_count, 0);
  const unpaidCount = events.reduce((sum, event) => sum + event.unpaid_count, 0);
  const totalDue = events.reduce((sum, event) => sum + Number(event.expected_total ?? 0), 0);
  const webhookUrl = `${origin || "https://your-domain.vercel.app"}/api/line/webhook`;
  const liffUrl = `${origin || "https://your-domain.vercel.app"}/liff`;
  const targetRows =
    detail?.targets.filter((target) => {
      if (targetFilter === "paid") return target.status === "verified";
      if (targetFilter === "review") return target.status === "manual_review";
      if (targetFilter === "unpaid") return target.status !== "verified";
      return true;
    }) ?? [];
  const slipRows =
    detail?.slips.filter((slip) => {
      if (slipFilter === "review") return slip.status === "manual_review";
      if (slipFilter === "paid") return slip.status === "verified";
      if (slipFilter === "problem") {
        return ["amount_mismatch", "duplicate_slip", "rejected"].includes(slip.status);
      }
      return true;
    }) ?? [];

  return (
    <div className="page">
      <header className="hero">
        <div className="heroGlow" />
        <div className="brand">
          <span className="brandKicker">
            <Sparkles size={15} />
            ระบบจัดการสลิป LINE
          </span>
          <h1>แดชบอร์ดรับสลิปและติดตามยอดโอน</h1>
          <p>รวมงานเรียกเก็บเงิน รายชื่อค้างจ่าย ไฟล์สลิป และพื้นที่ Supabase ไว้ในหน้าจอเดียว</p>
          <div className="heroPills">
            <span>
              <ShieldCheck size={15} />
              เก็บสลิปแบบ private
            </span>
            <span>
              <CheckCircle2 size={15} />
              ตรวจสถานะรายชื่อ
            </span>
            <span>
              <Clock3 size={15} />
              พร้อมล้างข้อมูลหลังปิดงาน
            </span>
          </div>
        </div>
        <div className="loginCard">
          <span className="loginLabel">เข้าสู่หลังบ้านอย่างปลอดภัย</span>
          {adminUser ? (
            <div className="adminSession">
              <span className="sessionEmail">
                <Mail size={16} />
                {adminUser.email}
              </span>
              <div className="actions">
                <button className="btn primary" disabled={busy} onClick={() => loadAll()}>
                  <RefreshCw size={16} />
                  {busy ? "กำลังโหลด" : "โหลดข้อมูล"}
                </button>
                <button className="btn subtle" disabled={busy} onClick={logoutAdmin}>
                  <LogOut size={16} />
                  ออกจากระบบ
                </button>
              </div>
            </div>
          ) : (
            <div className="loginForm">
              <input
                aria-label="อีเมลผู้ดูแล"
                autoComplete="email"
                inputMode="email"
                placeholder="อีเมลผู้ดูแล"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
              <input
                aria-label="รหัสผ่าน"
                autoComplete="current-password"
                placeholder="รหัสผ่าน"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void loginAdmin();
                }}
              />
              <button
                className="btn primary"
                disabled={!email.trim() || !password || busy || authChecking}
                onClick={loginAdmin}
              >
                <ShieldCheck size={16} />
                {busy || authChecking ? "กำลังตรวจสอบ" : "เข้าสู่ระบบ"}
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="main">
        {error ? (
          <section className="alertPanel">
            <span className="badge danger">ข้อผิดพลาด</span>
            <p>{error}</p>
            <button className="iconButton" onClick={() => setError(null)} aria-label="ปิดข้อความผิดพลาด">
              ปิด
            </button>
          </section>
        ) : null}

        <nav className="pageTabs" aria-label="เมนูหลังบ้าน">
          {[
            ["overview", "ภาพรวม"],
            ["events", "งานเรียกเก็บเงิน"],
            ["targets", "รายชื่อ"],
            ["slips", "ไฟล์สลิป"],
            ["storage", "พื้นที่/ล้างข้อมูล"],
            ["richmenu", "Rich Menu"],
            ["line", "ตั้งค่า LINE"]
          ].map(([value, label]) => (
            <button
              key={value}
              className={activePage === value ? "active" : ""}
              onClick={() => setActivePage(value)}
            >
              {label}
            </button>
          ))}
        </nav>

        <section className="overviewStrip" hidden={activePage !== "overview"}>
          <div>
            <span>งานทั้งหมด</span>
            <strong>{events.length}</strong>
          </div>
          <div>
            <span>ยอดรวมที่ต้องเก็บ</span>
            <strong>{formatMoney(totalDue)}</strong>
          </div>
          <div>
            <span>จ่ายแล้ว</span>
            <strong>{paidCount}</strong>
          </div>
          <div>
            <span>ยังไม่จ่าย</span>
            <strong>{unpaidCount}</strong>
          </div>
        </section>

        <section className="grid" hidden={activePage !== "overview" && activePage !== "storage"}>
          <div className="panel stat accentMint">
            <div className="panelHeader">
              <h2>พื้นที่เก็บไฟล์</h2>
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

          <div className="panel stat accentSky">
            <div className="panelHeader">
              <h2>ฐานข้อมูล</h2>
              <Archive size={20} />
            </div>
            <strong>{usage ? formatBytes(usage.database.used_bytes_estimate) : "-"}</strong>
            <p className="muted">
              ประมาณจากข้อมูลที่ใช้ในแดชบอร์ด · ขีดจำกัด {usage ? formatBytes(usage.database.limit_bytes) : "-"}
            </p>
            <div className={`progress ${toneClass(dbPct)}`}>
              <span style={{ width: `${dbPct}%` }} />
            </div>
            {dbPct >= 70 ? <span className="badge warn">ใกล้เต็ม {dbPct}%</span> : null}
          </div>

          <div className="panel stat accentPink">
            <div className="panelHeader">
              <h2>ใช้งานสูงสุด</h2>
              <AlertTriangle size={20} />
            </div>
            <strong>{usage?.events[0]?.event_name ?? "-"}</strong>
            <p className="muted">
              {usage?.events[0] ? formatBytes(usage.events[0].storage_bytes) : "ยังไม่มีไฟล์"}
            </p>
          </div>
        </section>

        <section className="panel" hidden={activePage !== "events" && activePage !== "storage"}>
          <div className="panelHeader">
            <div>
              <h2>งานเรียกเก็บเงิน</h2>
              <p className="muted">เลือกงานเพื่อดูคนยังไม่จ่ายและรายการไฟล์สลิป</p>
            </div>
            <div className="actions">
              <span className="badge">{events.length} งาน</span>
              <button
                className="btn primary"
                disabled={!adminUser || busy}
                onClick={() => setCreateEventOpen(true)}
              >
                <Plus size={16} />
                เพิ่มงานเก็บเงิน
              </button>
            </div>
          </div>
          <div className="tableWrap">
            <table className="dataTable">
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
                      <button
                        className={selectedEventId === event.id ? "btn selected" : "btn"}
                        onClick={() => selectEvent(event.id)}
                      >
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
                          className="btn subtle"
                          onClick={() =>
                            authenticatedDownload(`/api/admin/events/${event.id}/export.csv`)
                          }
                        >
                          <FileSpreadsheet size={15} />
                          ไฟล์สรุป
                        </button>
                        <button
                          className="btn subtle"
                          onClick={() =>
                            authenticatedDownload(`/api/admin/events/${event.id}/slips.zip`)
                          }
                        >
                          <Download size={15} />
                          ดาวน์โหลดสลิป
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
          <section
            className="detailGrid"
            hidden={activePage !== "targets" && activePage !== "slips"}
          >
            <div className="panel" hidden={activePage !== "targets"}>
              <div className="panelHeader">
                <div>
                  <h2>รายชื่อการชำระเงิน</h2>
                  <p className="muted">{selectedEvent.name}</p>
                </div>
                <span className="circleIcon">
                  <Users size={20} />
                </span>
              </div>
              <div className="segmented">
                {[
                  ["unpaid", "ยังไม่จ่าย"],
                  ["paid", "จ่ายแล้ว"],
                  ["review", "รอตรวจ"],
                  ["all", "ทั้งหมด"]
                ].map(([value, label]) => (
                  <button
                    key={value}
                    className={targetFilter === value ? "active" : ""}
                    onClick={() => setTargetFilter(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="tableWrap">
                <table className="dataTable compactTable">
                  <thead>
                    <tr>
                      <th>ชื่อ</th>
                      <th>ยอด</th>
                      <th>สถานะ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {targetRows.map((target) => (
                      <tr key={target.id}>
                        <td>{target.display_name}</td>
                        <td>{formatMoney(target.amount_due)}</td>
                        <td>
                          <span className={target.status === "verified" ? "badge ok" : "badge warn"}>
                            {statusLabels[target.status] ?? target.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="actions panelActions">
                <button
                  className="btn subtle"
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
                <button
                  className="btn subtle"
                  onClick={() =>
                    authenticatedDownload(`/api/admin/events/${selectedEvent.id}/unpaid.csv`)
                  }
                >
                  <FileSpreadsheet size={15} />
                  ดาวน์โหลดรายชื่อค้างจ่าย
                </button>
              </div>
            </div>

            <div className="panel" hidden={activePage !== "slips"}>
              <div className="panelHeader">
                <div>
                  <h2>ไฟล์สลิป</h2>
                  <p className="muted">เปิดดูผ่าน signed URL และจัดการข้อมูลหลังปิดงาน</p>
                </div>
                <div className="actions">
                  <button
                    className="btn subtle"
                    onClick={() =>
                      authenticatedDownload(`/api/admin/events/${selectedEvent.id}/unpaid.csv`)
                    }
                  >
                    <FileSpreadsheet size={15} />
                    รายชื่อค้างจ่าย
                  </button>
                  <button
                    className="btn danger"
                    onClick={() => setCleanup({ mode: "files_and_metadata", event: selectedEvent })}
                  >
                    ลบรูปและข้อมูลสลิป
                  </button>
                  <button
                    className="btn danger"
                    onClick={() => setCleanup({ mode: "event", event: selectedEvent })}
                  >
                    ปิด/ล้างงาน
                  </button>
                </div>
              </div>
              <div className="segmented">
                {[
                  ["all", "ทั้งหมด"],
                  ["review", "รอตรวจ"],
                  ["paid", "จ่ายแล้ว"],
                  ["problem", "มีปัญหา"]
                ].map(([value, label]) => (
                  <button
                    key={value}
                    className={slipFilter === value ? "active" : ""}
                    onClick={() => setSlipFilter(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="tableWrap">
                <table className="dataTable compactTable">
                  <thead>
                    <tr>
                      <th>ชื่อ</th>
                      <th>สถานะ</th>
                      <th>ยอด</th>
                      <th>ขนาด</th>
                      <th>วันที่</th>
                      <th>จัดการ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {slipRows.map((slip) => (
                      <tr key={slip.id}>
                        <td>{slip.payment_targets?.display_name ?? "-"}</td>
                        <td>
                          <span className={slip.status === "verified" ? "badge ok" : "badge"}>
                            {statusLabels[slip.status] ?? slip.status}
                          </span>
                        </td>
                        <td>{formatMoney(slip.amount_expected)}</td>
                        <td>{formatBytes(slip.file_size)}</td>
                        <td>{new Date(slip.created_at).toLocaleString("th-TH")}</td>
                        <td>
                          <div className="actions">
                            <button
                              className="btn subtle"
                              disabled={!slip.storage_path || Boolean(slip.file_deleted_at)}
                              onClick={() => openSlip(slip.id)}
                            >
                              <Eye size={15} />
                              เปิด
                            </button>
                            <button
                              className="btn subtle"
                              disabled={!slip.storage_path || Boolean(slip.file_deleted_at)}
                              onClick={() => authenticatedDownload(`/api/admin/slips/${slip.id}/download`)}
                            >
                              <Download size={15} />
                              โหลด
                            </button>
                            <button
                              className="btn subtle"
                              disabled={busy || slip.status === "verified"}
                              onClick={() => updateSlipStatus(slip.id, "verified")}
                            >
                              อนุมัติ
                            </button>
                            <button
                              className="btn danger"
                              disabled={busy || slip.status === "rejected"}
                              onClick={() => updateSlipStatus(slip.id, "rejected")}
                            >
                              ปฏิเสธ
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        ) : null}

        <section className="panel" hidden={activePage !== "line"}>
          <div className="panelHeader">
            <div>
              <h2>ตั้งค่าการเชื่อมต่อ LINE</h2>
              <p className="muted">นำ Webhook URL นี้ไปใส่ใน LINE Developers และตั้งค่า Environment Variables บน Vercel</p>
            </div>
            <span className="badge ok">พร้อมใช้งาน Webhook</span>
          </div>
          <div className="lineGrid">
            <div className="setupCard">
              <span className="setupLabel">Webhook URL</span>
              <code className="codeBox">{webhookUrl}</code>
              <button
                className="btn subtle"
                onClick={() => navigator.clipboard.writeText(webhookUrl)}
              >
                คัดลอก Webhook URL
              </button>
            </div>
            <div className="setupCard">
              <span className="setupLabel">Environment Variables ที่ต้องมี</span>
              <ul className="setupList">
                <li>LINE_CHANNEL_SECRET</li>
                <li>LINE_CHANNEL_ACCESS_TOKEN</li>
                <li>NEXT_PUBLIC_LIFF_ID</li>
                <li>LINE_LIFF_CHANNEL_ID</li>
                <li>NEXT_PUBLIC_SUPABASE_URL</li>
                <li>SUPABASE_SERVICE_ROLE_KEY</li>
                <li>SUPABASE_SLIPS_BUCKET</li>
                <li>ADMIN_EMAIL</li>
                <li>ADMIN_PASSWORD_HASH</li>
                <li>ADMIN_SESSION_SECRET</li>
              </ul>
            </div>
            <div className="setupCard">
              <span className="setupLabel">LIFF Endpoint URL</span>
              <code className="codeBox">{liffUrl}</code>
              <button
                className="btn subtle"
                onClick={() => navigator.clipboard.writeText(liffUrl)}
              >
                คัดลอก LIFF URL
              </button>
            </div>
            <div className="setupCard">
              <span className="setupLabel">วิธีทดสอบ</span>
              <p className="muted">
                หลังใส่ค่า LINE แล้ว ให้สร้าง LIFF app โดยใช้ Endpoint URL นี้,
                นำ LIFF URL ไปผูกกับ Rich Menu, เพิ่ม LINE OA เป็นเพื่อน แล้วเลือกชื่อก่อนส่งสลิป
              </p>
            </div>
          </div>
        </section>

        <section hidden={activePage !== "richmenu"}>
          <RichMenuBuilder
            isAuthenticated={Boolean(adminUser)}
            busy={busy}
            setBusy={setBusy}
            setError={setError}
            origin={origin || "https://line-google-line-line-line-line.vercel.app"}
          />
        </section>
      </main>

      {cleanup ? (
        <div className="modalBackdrop">
          <div className="modal">
            <h3>ยืนยันการล้างข้อมูล</h3>
            <p>
              โหมด: <strong>{cleanupModeLabels[cleanup.mode]}</strong>
              <br />
              งาน: <strong>{cleanup.event.name}</strong>
            </p>
            <p className="muted">พิมพ์ชื่องานให้ตรงเพื่อยืนยัน การกระทำนี้จะถูกบันทึกประวัติผู้ดูแล</p>
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

      {createEventOpen ? (
        <div className="modalBackdrop">
          <div className="modal wideModal">
            <div>
              <span className="badge ok">สร้างงานใหม่</span>
              <h3>เพิ่มงานเก็บเงิน</h3>
              <p className="muted">
                วางรายชื่อจาก Google Sheets หรือ Excel ได้เลย ถ้าแต่ละคนยอดต่างกันให้วางเป็น “ชื่อ + ยอดเงิน”
                ถ้ายอดเท่ากันทุกคนให้กรอกยอดกลางแล้ววางเฉพาะชื่อ
              </p>
            </div>

            <label className="field">
              <span>ชื่องาน</span>
              <input
                value={newEventName}
                onChange={(event) => setNewEventName(event.target.value)}
                placeholder="เช่น ค่าทริปห้อง ป.6"
              />
            </label>

            <div className="formGrid">
              <label className="field">
                <span>PromptPay ID / เบอร์รับเงิน</span>
                <input
                  value={newPromptpayId}
                  onChange={(event) => setNewPromptpayId(event.target.value)}
                  placeholder="เช่น 089xxxxxxx"
                />
              </label>
              <label className="field">
                <span>ยอดกลาง กรณีทุกคนจ่ายเท่ากัน</span>
                <input
                  inputMode="decimal"
                  value={newDefaultAmount}
                  onChange={(event) => setNewDefaultAmount(event.target.value)}
                  placeholder="เช่น 500"
                />
              </label>
            </div>

            <label className="field">
              <span>รายชื่อและยอดเงิน</span>
              <textarea
                rows={8}
                value={newTargetsText}
                onChange={(event) => setNewTargetsText(event.target.value)}
                placeholder={"สมชาย\t500\nสมหญิง\t650\nมานะ\t500"}
              />
            </label>

            <div className="hintBox">
              <strong>รูปแบบที่รองรับ</strong>
              <p>สมชาย 500, สมชาย[TAB]500, หรือวางเฉพาะรายชื่อทีละบรรทัดเมื่อกรอกยอดกลางแล้ว</p>
            </div>

            <div className="actions modalActions">
              <button className="btn" onClick={() => setCreateEventOpen(false)}>
                ยกเลิก
              </button>
              <button
                className="btn primary"
                disabled={!newEventName.trim() || !newTargetsText.trim() || busy}
                onClick={createEvent}
              >
                {busy ? "กำลังสร้าง" : "สร้างงานเก็บเงิน"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {previewUrl ? (
        <div className="modalBackdrop" onClick={() => setPreviewUrl(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="preview" src={previewUrl} alt="ตัวอย่างสลิป" />
        </div>
      ) : null}
    </div>
  );
}
