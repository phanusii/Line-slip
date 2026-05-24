"use client";

import { useEffect, useMemo, useState } from "react";
import { formatMoney } from "@/lib/format";

type LiffProfile = {
  userId: string;
  displayName: string;
  pictureUrl?: string;
};

type LiffApi = {
  init: (options: { liffId: string }) => Promise<void>;
  isLoggedIn: () => boolean;
  login: (options?: { redirectUri?: string }) => void;
  getAccessToken: () => string | null;
  getProfile: () => Promise<LiffProfile>;
  closeWindow: () => void;
};

type LiffMode = "pay" | "slip" | "me";

type EventRow = {
  id: string;
  name: string;
  slug: string;
  has_promptpay: boolean;
  targets: Array<{
    id: string;
    display_name: string;
    amount_due: number;
    status: string;
    is_selected: boolean;
  }>;
};

type SelectionResult = {
  event: { id: string; name: string };
  target: { id: string; display_name: string; amount_due: number; status?: string };
  qr: { data_url: string; payload: string };
};

type MyPayment = {
  id: string;
  display_name: string;
  amount_due: number;
  status: string;
  paid_at: string | null;
  event: { id: string; name: string; slug: string; is_open: boolean } | null;
  slips: Array<{
    id: string;
    status: string;
    amount_detected: number | null;
    amount_expected: number | null;
    created_at: string;
    file_deleted_at: string | null;
  }>;
};

const statusText: Record<string, string> = {
  unpaid: "ยังไม่จ่าย",
  pending_slip: "รอส่งสลิป",
  verified: "จ่ายแล้ว ✓",
  manual_review: "รอตรวจสอบ",
  amount_mismatch: "ยอดไม่ตรง",
  duplicate_slip: "สลิปซ้ำ",
  rejected: "ไม่ผ่าน",
  deleted: "ลบแล้ว"
};

const modeTitle: Record<LiffMode, string> = {
  pay: "สร้าง QR Code",
  slip: "ส่งสลิป",
  me: "สถานะของฉัน"
};

// Inline SVG icons (path-only, stroke or fill coloured via currentColor)
function IconQr() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1"/>
      <rect x="14" y="3" width="7" height="7" rx="1"/>
      <rect x="3" y="14" width="7" height="7" rx="1"/>
      <rect x="14" y="14" width="3" height="3"/>
      <rect x="18" y="14" width="3" height="3"/>
      <rect x="14" y="18" width="3" height="3"/>
      <rect x="18" y="18" width="3" height="3"/>
    </svg>
  );
}

function IconSlip() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="9" y1="13" x2="15" y2="13"/>
      <line x1="9" y1="17" x2="12" y2="17"/>
    </svg>
  );
}

function IconStatus() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
      <polyline points="22 4 12 14.01 9 11.01"/>
    </svg>
  );
}

function IconChat() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
  );
}

declare global {
  interface Window {
    liff?: LiffApi;
  }
}

function loadLiffSdk() {
  return new Promise<void>((resolve, reject) => {
    if (window.liff) {
      resolve();
      return;
    }

    const script = document.createElement("script");
    script.src = "https://static.line-scdn.net/liff/edge/2/sdk.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("โหลด LIFF SDK ไม่สำเร็จ"));
    document.head.appendChild(script);
  });
}

async function jsonFetch<T>(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "เกิดข้อผิดพลาด");
  return data as T;
}

function withLineAccessToken(accessToken: string, init?: RequestInit): RequestInit {
  return {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      authorization: `Bearer ${accessToken}`
    }
  };
}

function modeFromUrl(): LiffMode {
  const page = new URLSearchParams(window.location.search).get("page");
  if (page === "slip" || page === "me") return page;
  return "pay";
}

export default function LiffPaymentPage() {
  const liffId = process.env.NEXT_PUBLIC_LIFF_ID ?? "";
  const [mode, setMode] = useState<LiffMode>("pay");
  const [events, setEvents] = useState<EventRow[]>([]);
  const [selectedEventId, setSelectedEventId] = useState("");
  const [selectedTargetId, setSelectedTargetId] = useState("");
  const [search, setSearch] = useState("");
  const [profile, setProfile] = useState<LiffProfile | null>(null);
  const [accessToken, setAccessToken] = useState("");
  const [result, setResult] = useState<SelectionResult | null>(null);
  const [myPayments, setMyPayments] = useState<MyPayment[]>([]);
  const [contactUrl, setContactUrl] = useState("");
  const [slipFile, setSlipFile] = useState<File | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    async function boot() {
      if (!liffId) { setBooting(false); return; }
      setError(null);
      try {
        const activeMode = modeFromUrl();
        setMode(activeMode);
        await loadLiffSdk();
        if (!window.liff) throw new Error("ไม่พบ LIFF SDK");
        await window.liff.init({ liffId });
        if (!window.liff.isLoggedIn()) {
          window.liff.login({ redirectUri: window.location.href });
          return;
        }

        const token = window.liff.getAccessToken();
        if (!token) throw new Error("ไม่พบ LINE access token กรุณาเปิดผ่าน LINE อีกครั้ง");
        setAccessToken(token);

        // Profile + contact are non-critical — fire and forget
        void window.liff.getProfile().then((p) => setProfile(p)).catch(() => null);
        void jsonFetch<{ contactUrl: string }>("/api/liff/contact", withLineAccessToken(token))
          .then((data) => setContactUrl(data.contactUrl))
          .catch(() => null);

        // Phase 1 complete — show the UI shell immediately
        setBooting(false);

        // Phase 2 — load mode data behind a busy indicator, not a full-screen spinner
        setBusy(true);
        try {
          await loadMode(activeMode, token);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBooting(false);
      }
    }

    void boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liffId]);

  const selectedEvent = useMemo(
    () => events.find((event) => event.id === selectedEventId) ?? events[0],
    [events, selectedEventId]
  );

  const filteredTargets = useMemo(() => {
    const targets = selectedEvent?.targets ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return targets;
    return targets.filter((target) => target.display_name.toLowerCase().includes(q));
  }, [search, selectedEvent]);

  async function loadMode(nextMode: LiffMode, token = accessToken) {
    if (!token) return;
    setError(null);
    setNotice(null);
    if (nextMode === "me") {
      const meData = await jsonFetch<{ payments: MyPayment[] }>("/api/liff/me", {
        method: "POST",
        body: JSON.stringify({ accessToken: token })
      });
      setMyPayments(meData.payments);
      return;
    }

    if (nextMode === "slip") {
      const active = await jsonFetch<{ selection: SelectionResult | null }>(
        "/api/liff/active-selection",
        { method: "POST", body: JSON.stringify({ accessToken: token }) }
      );
      if (active.selection) {
        setResult(active.selection);
        return;
      }
      setMode("pay");
      window.history.replaceState(null, "", "/liff?page=pay");
      setNotice("ยังไม่พบ QR ที่สร้างไว้ กรุณาเลือกงานและรายชื่อก่อนส่งสลิป");
    }

    const eventsData = await jsonFetch<{ events: EventRow[] }>(
      "/api/liff/events",
      withLineAccessToken(token)
    );
    setEvents(eventsData.events);
    setSelectedEventId(eventsData.events[0]?.id ?? "");
  }

  function switchMode(nextMode: LiffMode) {
    setMode(nextMode);
    setResult(nextMode === "pay" ? null : result);
    setError(null);
    setNotice(null);
    window.history.replaceState(null, "", `/liff?page=${nextMode}`);
    void loadMode(nextMode);
  }

  async function selectTarget(targetId = selectedTargetId) {
    if (!selectedEvent || !targetId || !accessToken) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const data = await jsonFetch<SelectionResult>("/api/liff/selection", {
        method: "POST",
        body: JSON.stringify({
          accessToken,
          eventId: selectedEvent.id,
          targetId
        })
      });
      setSelectedTargetId(targetId);
      setResult(data);
      const refreshed = await jsonFetch<{ events: EventRow[] }>(
        "/api/liff/events",
        withLineAccessToken(accessToken)
      );
      setEvents(refreshed.events);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function uploadSlipForTarget(targetId: string, file: File) {
    if (!accessToken || !targetId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const form = new FormData();
      form.set("accessToken", accessToken);
      form.set("targetId", targetId);
      form.set("file", file);
      const response = await fetch("/api/liff/slip", { method: "POST", body: form });
      const data = (await response.json()) as { message?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? "อัปโหลดสลิปไม่สำเร็จ");
      setNotice(data.message ?? "รับสลิปแล้ว รอผู้ดูแลตรวจสอบ");
      setSlipFile(null);
      if (mode === "me") await loadMode("me");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function uploadSlip() {
    if (!slipFile || !result?.target.id) return;
    await uploadSlipForTarget(result.target.id, slipFile);
    // After upload, mark as pending review so upload section hides automatically
    setResult((prev) =>
      prev ? { ...prev, target: { ...prev.target, status: "manual_review" } } : null
    );
  }

  if (!liffId) {
    return (
      <main className="liffShell">
        <header className="liffHero compactLiffHero">
          <h1>LINE Payment</h1>
        </header>
        <section className="liffCard">
          <span className="badge warn">ยังไม่ตั้งค่า</span>
          <p className="muted">ตั้งค่า NEXT_PUBLIC_LIFF_ID บน Vercel แล้ว redeploy</p>
        </section>
      </main>
    );
  }

  return (
    <main className="liffShell withFloatingBar">
      {/* ── Compact sticky header ── */}
      <header className="liffHero compactLiffHero">
        <h1>
          {modeTitle[mode]}
        </h1>
        {profile ? (
          <span className="badge ok" style={{ fontSize: "11px", maxWidth: "120px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {profile.displayName}
          </span>
        ) : booting ? (
          <span className="liffSpinner" style={{ width: 18, height: 18, borderWidth: 2 }} />
        ) : null}
        <p aria-hidden="false">
          {mode === "me"
            ? "ดูงานที่เลือกไว้และสถานะการตรวจสลิป"
            : "เลือกชื่อ สแกนจ่าย แล้วอัปโหลดสลิป"}
        </p>
      </header>

      {/* ── Error ── */}
      {error ? (
        <section className="alertPanel" role="alert">
          <span className="badge danger">ข้อผิดพลาด</span>
          <p>{error}</p>
        </section>
      ) : null}

      {/* ── Notice ── */}
      {notice ? (
        <div className="liffCard" style={{ background: "rgba(235,255,246,0.98)", borderColor: "rgba(7,147,111,0.2)" }}>
          <p style={{ margin: 0, fontSize: 13, color: "#065f46", fontWeight: 700 }}>
            {notice}
          </p>
        </div>
      ) : null}

      {/* ── Loading boot state ── */}
      {booting ? (
        <div className="liffLoading">
          <span className="liffSpinner" />
          <span>กำลังเชื่อมต่อ LINE…</span>
        </div>
      ) : mode === "me" ? (
        <StatusView
          payments={myPayments}
          busy={busy}
          onPay={() => switchMode("pay")}
          onUploadSlip={uploadSlipForTarget}
        />
      ) : (
        <>
          {!result ? (
            <section className="liffCard">
              <label className="field">
                <span>งานเรียกเก็บเงิน</span>
                <select
                  value={selectedEvent?.id ?? ""}
                  onChange={(e) => {
                    setSelectedEventId(e.target.value);
                    setSelectedTargetId("");
                    setResult(null);
                    setSearch("");
                  }}
                >
                  {events.map((ev) => (
                    <option key={ev.id} value={ev.id}>{ev.name}</option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span>ค้นหารายชื่อ</span>
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="พิมพ์ชื่อเพื่อค้นหา…"
                />
              </label>

              {busy && events.length === 0 ? (
                <div className="liffLoading" style={{ minHeight: 120 }}>
                  <span className="liffSpinner" />
                  <span style={{ fontSize: 13, color: "var(--muted)" }}>กำลังโหลดรายการ…</span>
                </div>
              ) : selectedEvent ? (
                <>
                  {!selectedEvent.has_promptpay ? (
                    <div className="hintBox">
                      <strong>ยังไม่มี PromptPay</strong>
                      <p>แจ้งผู้ดูแลให้ใส่ PromptPay ID ก่อนสร้าง QR Code</p>
                    </div>
                  ) : null}

                  <div className="targetList compactTargets">
                    {filteredTargets.length ? (
                      filteredTargets.map((target) => (
                        <button
                          key={target.id}
                          className={selectedTargetId === target.id ? "targetOption active" : "targetOption"}
                          disabled={busy || !selectedEvent.has_promptpay}
                          onClick={() => {
                            setSelectedTargetId(target.id);
                            void selectTarget(target.id);
                          }}
                        >
                          <span>
                            <strong>{target.display_name}</strong>
                            <small>
                              {target.is_selected ? "เคยเลือกไว้แล้ว" : (statusText[target.status] ?? target.status)}
                            </small>
                          </span>
                          <b>{formatMoney(target.amount_due)}</b>
                        </button>
                      ))
                    ) : (
                      <div className="emptyState">ไม่พบรายชื่อที่ค้นหา</div>
                    )}
                  </div>

                  {busy ? (
                    <div className="liffLoading" style={{ minHeight: 60 }}>
                      <span className="liffSpinner" />
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="emptyState">ยังไม่มีงานที่เปิดรับสลิป</div>
              )}
            </section>
          ) : (
            <PaymentAndSlipCard
              result={result}
              slipFile={slipFile}
              busy={busy}
              onFile={setSlipFile}
              onUpload={uploadSlip}
              onChangeName={() => {
                setResult(null);
                setSlipFile(null);
                setMode("pay");
                window.history.replaceState(null, "", "/liff?page=pay");
              }}
            />
          )}
        </>
      )}

      {/* ── Floating bottom nav ── */}
      <nav className="liffFloatingBar" aria-label="เมนูลัด">
        <button className={mode === "pay" ? "active" : ""} onClick={() => switchMode("pay")}>
          <span className="liffNavIcon"><IconQr /></span>
          <span>QR</span>
        </button>
        <button className={mode === "slip" ? "active" : ""} onClick={() => switchMode("slip")}>
          <span className="liffNavIcon"><IconSlip /></span>
          <span>สลิป</span>
        </button>
        <button className={mode === "me" ? "active" : ""} onClick={() => switchMode("me")}>
          <span className="liffNavIcon"><IconStatus /></span>
          <span>สถานะ</span>
        </button>
        <a
          href={contactUrl || "#"}
          onClick={(e) => {
            if (!contactUrl) {
              e.preventDefault();
              setNotice("ติดต่อผู้ดูแลผ่าน LINE Official Account นี้");
            }
          }}
        >
          <span className="liffNavIcon"><IconChat /></span>
          <span>ติดต่อ</span>
        </a>
      </nav>
    </main>
  );
}

// ── QR + Slip upload card ────────────────────────────────────────────────────

function PaymentAndSlipCard(props: {
  result: SelectionResult;
  slipFile: File | null;
  busy: boolean;
  onFile: (file: File | null) => void;
  onUpload: () => void;
  onChangeName: () => void;
}) {
  const { result, slipFile, busy, onFile, onUpload, onChangeName } = props;
  return (
    <section className="liffCard qrCard">
      {/* Amount chip */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
        <span className="badge ok" style={{ fontSize: 13, padding: "5px 12px" }}>
          {result.event.name}
        </span>
      </div>

      <h2>{result.target.display_name}</h2>

      <p style={{
        margin: 0,
        fontSize: 22,
        fontWeight: 800,
        color: "#514bd5",
        letterSpacing: "-0.5px"
      }}>
        {formatMoney(result.target.amount_due)}
        <span style={{ fontSize: 14, fontWeight: 700, color: "var(--muted)", marginLeft: 4 }}>บาท</span>
      </p>

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={result.qr.data_url} alt="PromptPay QR Code" />

      <p className="muted">สแกน QR แล้วถ่ายรูปสลิป อัปโหลดด้านล่างนี้</p>

      {result.target.status === "manual_review" ? (
        <div style={{ textAlign: "center", padding: "12px 0 4px" }}>
          <span className="badge warn" style={{ fontSize: 13, padding: "6px 14px" }}>
            ✓ รับสลิปแล้ว — รอตรวจสอบ
          </span>
          <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
            ผู้ดูแลจะตรวจสอบและยืนยันการชำระเงินของคุณเร็วๆ นี้
          </p>
        </div>
      ) : (
        <>
          <label className="uploadButton liffUpload">
            {slipFile ? `📎 ${slipFile.name}` : "เลือกรูปสลิป"}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(e) => onFile(e.target.files?.[0] ?? null)}
            />
          </label>

          <button
            className="btn primary liffPrimary"
            disabled={!slipFile || busy}
            onClick={onUpload}
            style={{ marginTop: 2 }}
          >
            {busy ? (
              <><span className="liffSpinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> กำลังอัปโหลด</>
            ) : "อัปโหลดสลิป"}
          </button>
        </>
      )}

      <button className="btn subtle liffPrimary" onClick={onChangeName}>
        เปลี่ยนงาน / รายชื่อ
      </button>
    </section>
  );
}

// ── My payment status view ───────────────────────────────────────────────────

function StatusView(props: {
  payments: MyPayment[];
  busy: boolean;
  onPay: () => void;
  onUploadSlip: (targetId: string, file: File) => Promise<void>;
}) {
  const [files, setFiles] = useState<Record<string, File | null>>({});
  const visiblePayments = props.payments.filter((p) => p.event);

  return (
    <section className="liffCard">
      {props.busy && visiblePayments.length === 0 ? (
        <div className="liffLoading" style={{ minHeight: 120 }}>
          <span className="liffSpinner" />
          <span style={{ fontSize: 13, color: "var(--muted)" }}>กำลังโหลดสถานะ…</span>
        </div>
      ) : visiblePayments.length ? (
        <div className="paymentStatusList">
          {visiblePayments.map((payment) => {
            const latestSlip = payment.slips[0];
            const canUpload = payment.status !== "verified" && payment.status !== "manual_review";
            return (
              <article
                className="paymentStatusCard"
                key={payment.id}
                data-status={payment.status}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                  <span
                    className={payment.status === "verified" ? "badge ok" : "badge warn"}
                    style={{ fontSize: 11 }}
                  >
                    {statusText[payment.status] ?? payment.status}
                  </span>
                  <strong style={{ fontSize: 14, color: "#514bd5" }}>
                    {formatMoney(payment.amount_due)} บาท
                  </strong>
                </div>

                <h2>{payment.event?.name ?? "ไม่พบชื่องาน"}</h2>

                <div className="statusMeta">
                  <span>{payment.display_name}</span>
                  {payment.paid_at ? (
                    <span style={{ fontSize: 10, color: "var(--muted)" }}>
                      {new Date(payment.paid_at).toLocaleDateString("th-TH", { day: "numeric", month: "short" })}
                    </span>
                  ) : null}
                </div>

                {latestSlip ? (
                  <p className="muted">
                    สลิปล่าสุด: {statusText[latestSlip.status] ?? latestSlip.status} ·{" "}
                    {new Date(latestSlip.created_at).toLocaleString("th-TH", {
                      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
                    })}
                  </p>
                ) : (
                  <p className="muted">ยังไม่มีสลิปในระบบ</p>
                )}

                {canUpload ? (
                  <div className="statusUpload">
                    <label className="uploadButton miniUpload">
                      เลือกสลิป
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        onChange={(e) =>
                          setFiles((cur) => ({
                            ...cur,
                            [payment.id]: e.target.files?.[0] ?? null
                          }))
                        }
                      />
                    </label>
                    {files[payment.id] ? (
                      <span className="fileName">{files[payment.id]?.name}</span>
                    ) : null}
                    <button
                      className="btn primary compactBtn"
                      disabled={!files[payment.id] || props.busy}
                      onClick={async () => {
                        const file = files[payment.id];
                        if (!file) return;
                        await props.onUploadSlip(payment.id, file);
                        setFiles((cur) => ({ ...cur, [payment.id]: null }));
                      }}
                    >
                      {props.busy ? "กำลังส่ง" : "ส่ง"}
                    </button>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : (
        <div className="emptyState">
          ยังไม่เคยสร้าง QR Code<br />กรุณากดปุ่ม QR เพื่อเลือกงาน
        </div>
      )}

      <button className="btn primary liffPrimary" onClick={props.onPay}>
        สร้าง QR Code ใหม่
      </button>
    </section>
  );
}
