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
  verified: "จ่ายแล้ว",
  manual_review: "รอตรวจ",
  amount_mismatch: "ยอดไม่ตรง",
  duplicate_slip: "สลิปซ้ำ",
  rejected: "ไม่ผ่าน",
  deleted: "ลบแล้ว"
};

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

  useEffect(() => {
    async function boot() {
      if (!liffId) return;
      setBusy(true);
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
        const profileData = await window.liff.getProfile();
        setProfile(profileData);
        setAccessToken(token);
        void jsonFetch<{ contactUrl: string }>("/api/liff/contact", withLineAccessToken(token))
          .then((data) => setContactUrl(data.contactUrl))
          .catch(() => null);
        await loadMode(activeMode, token);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    }

    void boot();
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
  }

  if (!liffId) {
    return (
      <main className="liffShell">
        <section className="liffCard">
          <span className="brandKicker">LINE LIFF</span>
          <h1>ยังไม่ได้ตั้งค่า LIFF ID</h1>
          <p className="muted">ตั้งค่า NEXT_PUBLIC_LIFF_ID บน Vercel แล้ว redeploy อีกครั้ง</p>
        </section>
      </main>
    );
  }

  return (
    <main className="liffShell withFloatingBar">
      <section className="liffHero compactLiffHero">
        <span className="brandKicker">LINE Payment</span>
        <h1>{mode === "me" ? "สถานะของฉัน" : mode === "slip" ? "ส่งสลิป" : "สร้าง QR Code"}</h1>
        <p>
          {mode === "me"
            ? "ดูงานที่เลือกไว้และสถานะการตรวจสลิป"
            : "เลือกชื่อ สแกนจ่าย แล้วอัปโหลดสลิปในหน้าเดียว"}
        </p>
        {profile ? <span className="badge ok">{profile.displayName}</span> : null}
      </section>

      {error ? (
        <section className="alertPanel">
          <span className="badge danger">ข้อผิดพลาด</span>
          <p>{error}</p>
        </section>
      ) : null}

      {notice ? (
        <section className="hintBox">
          <strong>แจ้งเตือน</strong>
          <p>{notice}</p>
        </section>
      ) : null}

      {mode === "me" ? (
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
                  onChange={(event) => {
                    setSelectedEventId(event.target.value);
                    setSelectedTargetId("");
                    setResult(null);
                    setSearch("");
                  }}
                >
                  {events.map((event) => (
                    <option key={event.id} value={event.id}>
                      {event.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span>ค้นหารายชื่อ</span>
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="พิมพ์ชื่อเพื่อค้นหาเร็ว ๆ"
                />
              </label>

              {selectedEvent ? (
                <>
                  {!selectedEvent.has_promptpay ? (
                    <div className="hintBox">
                      <strong>งานนี้ยังไม่มี PromptPay</strong>
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
                            <small>{target.is_selected ? "เคยเลือกไว้แล้ว" : statusText[target.status] ?? target.status}</small>
                          </span>
                          <b>{formatMoney(target.amount_due)}</b>
                        </button>
                      ))
                    ) : (
                      <div className="emptyState">ไม่พบรายชื่อที่ค้นหา</div>
                    )}
                  </div>
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

      <nav className="liffFloatingBar" aria-label="เมนูลัด">
        {[
          ["pay", "QR"],
          ["slip", "สลิป"],
          ["me", "สถานะ"]
        ].map(([value, label]) => (
          <button key={value} className={mode === value ? "active" : ""} onClick={() => switchMode(value as LiffMode)}>
            {label}
          </button>
        ))}
        <a href={contactUrl || "#"} onClick={(event) => {
          if (!contactUrl) {
            event.preventDefault();
            setNotice("กรุณาติดต่อผู้ดูแลผ่าน LINE Official Account นี้");
          }
        }}>
          ติดต่อ
        </a>
      </nav>
    </main>
  );
}

function PaymentAndSlipCard(props: {
  result: SelectionResult;
  slipFile: File | null;
  busy: boolean;
  onFile: (file: File | null) => void;
  onUpload: () => void;
  onChangeName: () => void;
}) {
  return (
    <section className="liffCard qrCard">
      <span className="badge ok">สร้าง QR แล้ว</span>
      <h2>{props.result.target.display_name}</h2>
      <p className="muted">
        {props.result.event.name} · ยอด {formatMoney(props.result.target.amount_due)} บาท
      </p>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={props.result.qr.data_url} alt="PromptPay QR Code" />
      <p className="muted">ถ่ายหน้าจอ QR นี้หรือสแกนจ่าย จากนั้นอัปโหลดสลิปด้านล่าง</p>
      <label className="uploadButton liffUpload">
        เลือกรูปสลิป
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(event) => props.onFile(event.target.files?.[0] ?? null)}
        />
      </label>
      {props.slipFile ? <p className="muted">{props.slipFile.name}</p> : null}
      <button className="btn primary liffPrimary" disabled={!props.slipFile || props.busy} onClick={props.onUpload}>
        {props.busy ? "กำลังอัปโหลด" : "อัปโหลดสลิป"}
      </button>
      <button className="btn subtle liffPrimary" onClick={props.onChangeName}>
        เปลี่ยนงาน/รายชื่อ
      </button>
    </section>
  );
}

function StatusView(props: {
  payments: MyPayment[];
  busy: boolean;
  onPay: () => void;
  onUploadSlip: (targetId: string, file: File) => Promise<void>;
}) {
  const [files, setFiles] = useState<Record<string, File | null>>({});
  const visiblePayments = props.payments.filter((payment) => payment.event);

  return (
    <section className="liffCard">
      {visiblePayments.length ? (
        <div className="paymentStatusList">
          {visiblePayments.map((payment) => {
            const latestSlip = payment.slips[0];
            const canUpload = payment.status !== "verified";
            return (
            <article className="paymentStatusCard" key={payment.id}>
              <span className={payment.status === "verified" ? "badge ok" : "badge warn"}>
                {statusText[payment.status] ?? payment.status}
              </span>
              <h2>{payment.event?.name ?? "ไม่พบชื่องาน"}</h2>
              <div className="statusMeta">
                <span>{payment.display_name}</span>
                <strong>{formatMoney(payment.amount_due)} บาท</strong>
              </div>
              {latestSlip ? (
                <p className="muted">
                  สลิปล่าสุด: {statusText[latestSlip.status] ?? latestSlip.status} ·{" "}
                  {new Date(latestSlip.created_at).toLocaleString("th-TH")}
                </p>
              ) : (
                <p className="muted">ยังไม่มีสลิปในระบบ</p>
              )}
              {canUpload ? (
                <div className="statusUpload">
                  <label className="uploadButton miniUpload">
                    เลือกรูปสลิป
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={(event) =>
                        setFiles((current) => ({
                          ...current,
                          [payment.id]: event.target.files?.[0] ?? null
                        }))
                      }
                    />
                  </label>
                  {files[payment.id] ? <span className="fileName">{files[payment.id]?.name}</span> : null}
                  <button
                    className="btn primary compactBtn"
                    disabled={!files[payment.id] || props.busy}
                    onClick={async () => {
                      const file = files[payment.id];
                      if (!file) return;
                      await props.onUploadSlip(payment.id, file);
                      setFiles((current) => ({ ...current, [payment.id]: null }));
                    }}
                  >
                    {props.busy ? "กำลังส่ง" : "ส่งสลิป"}
                  </button>
                </div>
              ) : null}
            </article>
          );
          })}
        </div>
      ) : (
        <div className="emptyState">ยังไม่เคยสร้าง QR Code กรุณาเลือกงานและรายชื่อก่อน</div>
      )}
      <button className="btn primary liffPrimary" onClick={props.onPay}>
        สร้าง QR Code
      </button>
    </section>
  );
}
