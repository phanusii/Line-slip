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
  target: { id: string; display_name: string; amount_due: number };
  qr: { data_url: string; payload: string };
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

export default function LiffPaymentPage() {
  const liffId = process.env.NEXT_PUBLIC_LIFF_ID ?? "";
  const [events, setEvents] = useState<EventRow[]>([]);
  const [selectedEventId, setSelectedEventId] = useState("");
  const [selectedTargetId, setSelectedTargetId] = useState("");
  const [profile, setProfile] = useState<LiffProfile | null>(null);
  const [accessToken, setAccessToken] = useState("");
  const [result, setResult] = useState<SelectionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function boot() {
      if (!liffId) return;
      setBusy(true);
      setError(null);
      try {
        await loadLiffSdk();
        if (!window.liff) throw new Error("ไม่พบ LIFF SDK");
        await window.liff.init({ liffId });
        if (!window.liff.isLoggedIn()) {
          window.liff.login({ redirectUri: window.location.href });
          return;
        }

        const token = window.liff.getAccessToken();
        if (!token) throw new Error("ไม่พบ LINE access token กรุณาเปิดผ่าน LINE อีกครั้ง");
        const [profileData, eventsData] = await Promise.all([
          window.liff.getProfile(),
          jsonFetch<{ events: EventRow[] }>("/api/liff/events")
        ]);
        setProfile(profileData);
        setAccessToken(token);
        setEvents(eventsData.events);
        setSelectedEventId(eventsData.events[0]?.id ?? "");
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

  async function selectTarget() {
    if (!selectedEvent || !selectedTargetId || !accessToken) return;
    setBusy(true);
    setError(null);
    try {
      const data = await jsonFetch<SelectionResult>("/api/liff/selection", {
        method: "POST",
        body: JSON.stringify({
          accessToken,
          eventId: selectedEvent.id,
          targetId: selectedTargetId
        })
      });
      setResult(data);
      const refreshed = await jsonFetch<{ events: EventRow[] }>("/api/liff/events");
      setEvents(refreshed.events);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!liffId) {
    return (
      <main className="liffShell">
        <section className="liffCard">
          <span className="brandKicker">LINE LIFF</span>
          <h1>ยังไม่ได้ตั้งค่า LIFF ID</h1>
          <p className="muted">
            สร้าง LIFF app ใน LINE Developers แล้วตั้งค่า Environment Variable
            ชื่อ NEXT_PUBLIC_LIFF_ID บน Vercel จากนั้น redeploy อีกครั้ง
          </p>
          <code className="codeBox">{typeof window !== "undefined" ? `${window.location.origin}/liff` : "/liff"}</code>
        </section>
      </main>
    );
  }

  return (
    <main className="liffShell">
      <section className="liffHero">
        <span className="brandKicker">ระบบเลือกงานผ่าน LINE</span>
        <h1>เลือกชื่อของคุณเพื่อรับ QR Code</h1>
        <p>เลือกงานและรายชื่อให้ถูกต้องก่อนโอนเงิน หลังโอนแล้วส่งรูปสลิปกลับมาในแชท LINE เดิม</p>
        {profile ? <span className="badge ok">เข้าสู่ระบบแล้ว: {profile.displayName}</span> : null}
      </section>

      {error ? (
        <section className="alertPanel">
          <span className="badge danger">ข้อผิดพลาด</span>
          <p>{error}</p>
        </section>
      ) : null}

      <section className="liffCard">
        <label className="field">
          <span>งานเรียกเก็บเงิน</span>
          <select
            value={selectedEvent?.id ?? ""}
            onChange={(event) => {
              setSelectedEventId(event.target.value);
              setSelectedTargetId("");
              setResult(null);
            }}
          >
            {events.map((event) => (
              <option key={event.id} value={event.id}>
                {event.name}
              </option>
            ))}
          </select>
        </label>

        {selectedEvent ? (
          <>
            {!selectedEvent.has_promptpay ? (
              <div className="hintBox">
                <strong>งานนี้ยังไม่มี PromptPay</strong>
                <p>แจ้งผู้ดูแลให้ใส่ PromptPay ID ตอนสร้างงาน หรือสร้างงานใหม่พร้อม PromptPay</p>
              </div>
            ) : null}

            <div className="targetList">
              {selectedEvent.targets.length ? (
                selectedEvent.targets.map((target) => (
                  <button
                    key={target.id}
                    className={selectedTargetId === target.id ? "targetOption active" : "targetOption"}
                    disabled={busy || !selectedEvent.has_promptpay}
                    onClick={() => {
                      setSelectedTargetId(target.id);
                      setResult(null);
                    }}
                  >
                    <span>
                      <strong>{target.display_name}</strong>
                      <small>{target.is_selected ? "มีผู้เลือกไว้แล้ว" : "ยังไม่ส่งสลิป"}</small>
                    </span>
                    <b>{formatMoney(target.amount_due)}</b>
                  </button>
                ))
              ) : (
                <div className="emptyState">งานนี้ไม่มีรายชื่อค้างจ่ายแล้ว</div>
              )}
            </div>

            <button
              className="btn primary liffPrimary"
              disabled={!selectedTargetId || busy || !selectedEvent.has_promptpay}
              onClick={selectTarget}
            >
              {busy ? "กำลังสร้าง QR" : "ยืนยันและสร้าง QR Code"}
            </button>
          </>
        ) : (
          <div className="emptyState">ยังไม่มีงานที่เปิดรับสลิป</div>
        )}
      </section>

      {result ? (
        <section className="liffCard qrCard">
          <span className="badge ok">เลือกสำเร็จ</span>
          <h2>{result.target.display_name}</h2>
          <p className="muted">
            งาน {result.event.name} · ยอด {formatMoney(result.target.amount_due)} บาท
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={result.qr.data_url} alt="PromptPay QR Code" />
          <p className="muted">หลังโอนเงินเสร็จ ให้กลับไปที่แชท LINE แล้วส่งรูปสลิปเข้ามา</p>
          <button className="btn subtle liffPrimary" onClick={() => window.liff?.closeWindow()}>
            กลับไปส่งสลิปใน LINE
          </button>
        </section>
      ) : null}
    </main>
  );
}
