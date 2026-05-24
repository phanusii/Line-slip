"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
type UploadPhase = "idle" | "ready" | "uploading" | "done" | "error";

type UploadState = {
  phase: UploadPhase;
  message?: string;
  progress?: number;
};

type EventRow = {
  id: string;
  name: string;
  slug: string;
  has_promptpay: boolean;
  targets: Array<{
    id: string;
    order: number;
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

type SlipUploadResponse = {
  message?: string;
  error?: string;
  slip?: {
    id?: string;
    status: string;
    autoCheckStatus?: string | null;
  };
  alreadyVerified?: boolean;
};

type BootstrapResponse = {
  page: LiffMode;
  profile?: LiffProfile;
  contactUrl?: string;
  selection?: SelectionResult | null;
  events?: EventRow[];
  payments?: MyPayment[];
  notice?: string | null;
};

const eventsCacheKey = "line-slip:liff-events:v1";

function bootstrapCacheKey(mode: LiffMode) {
  return `line-slip:liff-bootstrap:${mode}:v3`;
}

function targetsCacheKey(eventId: string) {
  return `line-slip:liff-targets:${eventId}:v1`;
}

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

function canUploadSlip(status?: string) {
  return !status || ["unpaid", "pending_slip", "rejected", "amount_mismatch"].includes(status);
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

function readEventsCache() {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(eventsCacheKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { savedAt: number; events: EventRow[] };
    if (!parsed.savedAt || Date.now() - parsed.savedAt > 5 * 60_000) return null;
    return parsed.events;
  } catch {
    return null;
  }
}

function writeEventsCache(events: EventRow[]) {
  try {
    window.sessionStorage.setItem(
      eventsCacheKey,
      JSON.stringify({ savedAt: Date.now(), events })
    );
  } catch {
    // Ignore private browsing/session storage errors.
  }
}

function readTargetsCache(eventId: string) {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(targetsCacheKey(eventId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { savedAt: number; targets: EventRow["targets"] };
    if (!parsed.savedAt || Date.now() - parsed.savedAt > 5 * 60_000) return null;
    return parsed.targets;
  } catch {
    return null;
  }
}

function writeTargetsCache(eventId: string, targets: EventRow["targets"]) {
  try {
    window.sessionStorage.setItem(
      targetsCacheKey(eventId),
      JSON.stringify({ savedAt: Date.now(), targets })
    );
  } catch {
    // Ignore private browsing/session storage errors.
  }
}

function readBootstrapCache(mode: LiffMode) {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(bootstrapCacheKey(mode));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { savedAt: number; data: BootstrapResponse };
    if (!parsed.savedAt || Date.now() - parsed.savedAt > 5 * 60_000) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function writeBootstrapCache(mode: LiffMode, data: BootstrapResponse) {
  try {
    window.sessionStorage.setItem(
      bootstrapCacheKey(mode),
      JSON.stringify({ savedAt: Date.now(), data })
    );
  } catch {
    // Ignore private browsing/session storage errors.
  }
}

function loadImageFromObjectUrl(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("อ่านรูปสลิปไม่สำเร็จ"));
    image.src = url;
  });
}

async function compressSlipFile(file: File) {
  if (!file.type.startsWith("image/") || file.type === "image/gif") return file;

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImageFromObjectUrl(objectUrl);
    const maxEdge = 1600;
    const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(image, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.82)
    );
    if (!blob) return file;
    if (blob.size >= file.size && scale === 1) return file;

    const baseName = file.name.replace(/\.[^.]+$/, "") || "slip";
    return new File([blob], `${baseName}.jpg`, {
      type: "image/jpeg",
      lastModified: Date.now()
    });
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function uploadSlipForm(
  form: FormData,
  onProgress?: (progress: number) => void
) {
  return new Promise<SlipUploadResponse>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/liff/slip");
    xhr.responseType = "text";
    xhr.timeout = 45_000;
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      onProgress?.(Math.min(98, Math.max(1, Math.round((event.loaded / event.total) * 100))));
    };
    xhr.onload = () => {
      let data: SlipUploadResponse;
      try {
        data = JSON.parse(xhr.responseText || "{}") as SlipUploadResponse;
      } catch {
        reject(new Error("อ่านผลอัปโหลดไม่สำเร็จ"));
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(data.error ?? "อัปโหลดสลิปไม่สำเร็จ"));
        return;
      }
      onProgress?.(100);
      resolve(data);
    };
    xhr.onerror = () => reject(new Error("เครือข่ายไม่เสถียร กรุณาลองอัปโหลดใหม่"));
    xhr.ontimeout = () => reject(new Error("อัปโหลดนานเกินไป กรุณาลองใหม่ด้วยสัญญาณที่เสถียรกว่า"));
    xhr.send(form);
  });
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
  const [slipPreviewUrl, setSlipPreviewUrl] = useState<string | null>(null);
  const [uploadState, setUploadState] = useState<UploadState>({ phase: "idle" });
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [booting, setBooting] = useState(true);
  const [targetsLoading, setTargetsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modeRequestRef = useRef(0);
  const targetRequestRef = useRef(0);

  useEffect(() => {
    if (!slipFile) return;
    const url = URL.createObjectURL(slipFile);
    setSlipPreviewUrl(url);
    setUploadState({ phase: "ready", message: "เลือกรูปสลิปแล้ว กดอัปโหลดเพื่อส่งให้ระบบ" });
    return () => URL.revokeObjectURL(url);
  }, [slipFile]);

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

        // Phase 1 done — show UI shell immediately
        setBooting(false);

        // Phase 2 — load mode data behind busy indicator
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

  function applyBootstrap(data: BootstrapResponse) {
    setMode(data.page);
    if (data.profile) setProfile(data.profile);
    setContactUrl(data.contactUrl ?? "");
    if (data.notice) setNotice(data.notice);
    if (data.events) {
      writeEventsCache(data.events);
      setEvents(data.events);
      data.events.forEach((event) => {
        if (event.targets.length) writeTargetsCache(event.id, event.targets);
      });
      const preferredEventId =
        data.page === "slip"
          ? data.selection?.event.id ?? data.events[0]?.id ?? ""
          : data.events[0]?.id ?? "";
      setSelectedEventId(preferredEventId);
    }
    if (data.page === "slip" && data.selection) {
      setResult(data.selection);
      setSelectedTargetId(data.selection.target.id);
    } else if (data.page === "pay" || data.page === "me") {
      setResult(null);
      setSelectedTargetId("");
    }
    if (data.payments) {
      setMyPayments(data.payments);
    }
  }

  async function loadMode(nextMode: LiffMode, token = accessToken) {
    if (!token) return;
    const requestId = ++modeRequestRef.current;
    setError(null);
    setNotice(null);
    const cachedBootstrap = readBootstrapCache(nextMode);
    if (cachedBootstrap && modeRequestRef.current === requestId) {
      applyBootstrap(cachedBootstrap);
    }

    const data = await jsonFetch<BootstrapResponse>("/api/liff/bootstrap", {
      method: "POST",
      body: JSON.stringify({ accessToken: token, page: nextMode })
    });
    if (modeRequestRef.current !== requestId) return;
    writeBootstrapCache(nextMode, data);
    applyBootstrap(data);

    if (data.page !== nextMode) {
      window.history.replaceState(null, "", `/liff?page=${data.page}`);
    }
  }

  async function loadTargets(eventId: string, token = accessToken) {
    if (!eventId || !token) return;
    const requestId = ++targetRequestRef.current;
    const cachedTargets = readTargetsCache(eventId);
    if (cachedTargets && targetRequestRef.current === requestId) {
      setEvents((current) =>
        current.map((event) => (event.id === eventId ? { ...event, targets: cachedTargets } : event))
      );
    }

    setTargetsLoading(true);
    try {
      const data = await jsonFetch<{ targets: EventRow["targets"] }>(
        `/api/liff/targets?eventId=${encodeURIComponent(eventId)}`,
        withLineAccessToken(token)
      );
      if (targetRequestRef.current !== requestId) return;
      writeTargetsCache(eventId, data.targets);
      setEvents((current) =>
        current.map((event) => (event.id === eventId ? { ...event, targets: data.targets } : event))
      );
    } finally {
      if (targetRequestRef.current === requestId) {
        setTargetsLoading(false);
      }
    }
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
      setEvents((current) =>
        current.map((event) =>
          event.id === data.event.id
            ? {
                ...event,
                targets: event.targets.map((target) =>
                  target.id === targetId
                    ? { ...target, status: "pending_slip", is_selected: true }
                    : { ...target, is_selected: false }
                )
              }
            : event
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function uploadSlipForTarget(
    targetId: string,
    file: File,
    onProgress?: (progress: number) => void
  ) {
    if (!accessToken || !targetId) return null;
    setUploadState({ phase: "uploading", message: "กำลังเตรียมรูปสลิป...", progress: 2 });
    setError(null);
    setNotice(null);
    try {
      const uploadFile = await compressSlipFile(file);
      setUploadState({
        phase: "uploading",
        message: uploadFile.size < file.size ? "บีบอัดรูปแล้ว กำลังอัปโหลด..." : "กำลังอัปโหลดสลิป...",
        progress: 8
      });
      onProgress?.(8);
      const form = new FormData();
      form.set("accessToken", accessToken);
      form.set("targetId", targetId);
      form.set("file", uploadFile);
      const data = await uploadSlipForm(form, (progress) => {
        setUploadState({ phase: "uploading", message: "กำลังอัปโหลดสลิป...", progress });
        onProgress?.(progress);
      });
      const message = data.message ?? "อัปโหลดสลิปเสร็จแล้ว รอผู้ดูแลตรวจสอบ";
      setUploadState({ phase: "done", message, progress: 100 });
      setNotice(message);
      const nextStatus = data.alreadyVerified
        ? "verified"
        : data.slip?.status === "verified"
          ? "verified"
          : "manual_review";
      setResult((current) =>
        current?.target.id === targetId
          ? { ...current, target: { ...current.target, status: nextStatus } }
          : current
      );
      if (mode === "me") await loadMode("me");
      return data;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setUploadState({ phase: "error", message, progress: 0 });
      setError(message);
      return null;
    } finally {
      setUploadState((current) =>
        current.phase === "uploading"
          ? { phase: "idle" }
          : current
      );
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
      <section className={result ? "liffHero compactLiffHero liffHeroWithResult" : "liffHero compactLiffHero"}>
        <span className="brandKicker">LINE Payment</span>
        <h1>{mode === "me" ? "สถานะของฉัน" : mode === "slip" ? "ส่งสลิป" : "สร้าง QR Code"}</h1>
        <p>
          {mode === "me"
            ? "ดูงานที่เลือกไว้และสถานะการตรวจสลิป"
            : "เลือกชื่อ สแกนจ่าย แล้วอัปโหลดสลิปในหน้าเดียว"}
        </p>
        {profile ? (
          <span className="badge ok">{profile.displayName}</span>
        ) : booting ? (
          <span className="liffSpinner" style={{ width: 18, height: 18, borderWidth: 2 }} />
        ) : null}
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
                  onChange={(event) => {
                    setSelectedEventId(event.target.value);
                    setSelectedTargetId("");
                    setResult(null);
                    setSearch("");
                    void loadTargets(event.target.value);
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
                    {targetsLoading && !filteredTargets.length ? (
                      <div className="emptyState">กำลังโหลดรายชื่อ...</div>
                    ) : filteredTargets.length ? (
                      filteredTargets.map((target) => (
                        <button
                          key={target.id}
                          className={selectedTargetId === target.id ? "targetOption active" : "targetOption"}
                          disabled={busy || !selectedEvent.has_promptpay}
                          onClick={() => {
                            setSelectedTargetId((prev) => prev === target.id ? "" : target.id);
                          }}
                        >
                          <span>
                            <strong>
                              <span style={{ color: "var(--muted)", fontWeight: 500, marginRight: 5, fontSize: 12 }}>
                                {target.order}.
                              </span>
                              {target.display_name}
                            </strong>
                            <small>{target.is_selected ? "เคยเลือกไว้แล้ว" : statusText[target.status] ?? target.status}</small>
                          </span>
                          <b>{formatMoney(target.amount_due)}</b>
                        </button>
                      ))
                    ) : (
                      <div className="emptyState">ไม่พบรายชื่อที่ค้นหา</div>
                    )}
                  </div>

                  {selectedTargetId ? (() => {
                    const t = filteredTargets.find((x) => x.id === selectedTargetId)
                      ?? selectedEvent?.targets.find((x) => x.id === selectedTargetId);
                    if (!t) return null;
                    return (
                      <div className="confirmPanel">
                        <p>
                          <strong>{t.display_name}</strong>
                          <span> · {formatMoney(t.amount_due)} บาท</span>
                        </p>
                        <button
                          className="btn primary liffPrimary"
                          disabled={busy || !selectedEvent.has_promptpay}
                          onClick={() => void selectTarget(selectedTargetId)}
                        >
                          {busy ? "กำลังสร้าง QR..." : "ยืนยัน — สร้าง QR Code"}
                        </button>
                      </div>
                    );
                  })() : null}
                </>
              ) : (
                <div className="emptyState">ยังไม่มีงานที่เปิดรับสลิป</div>
              )}
            </section>
          ) : (
            <PaymentAndSlipCard
              result={result}
              slipFile={slipFile}
              slipPreviewUrl={slipPreviewUrl}
              uploadState={uploadState}
              busy={busy}
              onFile={setSlipFile}
              onUpload={uploadSlip}
              onViewStatus={() => switchMode("me")}
              onChangeName={() => {
                setResult(null);
                setSelectedTargetId("");
                setSlipFile(null);
                setSlipPreviewUrl(null);
                setUploadState({ phase: "idle" });
                setMode("pay");
                window.history.replaceState(null, "", "/liff?page=pay");
                void loadMode("pay");
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
  slipPreviewUrl: string | null;
  uploadState: UploadState;
  busy: boolean;
  onFile: (file: File | null) => void;
  onUpload: () => void;
  onViewStatus: () => void;
  onChangeName: () => void;
}) {
  const isVerified = props.result.target.status === "verified";
  const uploadAllowed = canUploadSlip(props.result.target.status);
  const currentStatus = props.result.target.status ? statusText[props.result.target.status] ?? props.result.target.status : "สร้าง QR แล้ว";

  return (
    <section className="liffCard qrCard">
      <span className={isVerified ? "badge ok" : uploadAllowed ? "badge ok" : "badge warn"}>{currentStatus}</span>
      <h2>{props.result.target.display_name}</h2>
      <p className="muted">
        {props.result.event.name} · ยอด {formatMoney(props.result.target.amount_due)} บาท
      </p>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={props.result.qr.data_url} alt="PromptPay QR Code" />
      {isVerified ? (
        <p className="muted">รายการนี้จ่ายเรียบร้อยแล้ว ไม่ต้องส่งสลิปเพิ่ม</p>
      ) : !uploadAllowed ? (
        <p className="muted">
          ระบบได้รับสลิปแล้ว สถานะปัจจุบันคือ {currentStatus} ไม่ต้องอัปโหลดสลิปซ้ำ
        </p>
      ) : (
        <>
          <p className="muted">ถ่ายหน้าจอ QR นี้หรือสแกนจ่าย จากนั้นอัปโหลดสลิปด้านล่าง</p>
          <label className="uploadButton liffUpload">
            เลือกรูปสลิป
            <input
              type="file"
              accept="image/*"
              onChange={(event) => props.onFile(event.target.files?.[0] ?? null)}
            />
          </label>
          {props.slipPreviewUrl ? (
            <div className={`liffSlipPreview ${props.uploadState.phase}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={props.slipPreviewUrl} alt="รูปสลิปที่เลือก" />
              <div>
                <strong>
                  {props.uploadState.phase === "done"
                    ? "อัปโหลดสลิปเสร็จแล้ว"
                    : props.uploadState.phase === "uploading"
                      ? "กำลังอัปโหลดสลิป"
                      : "รูปสลิปที่เลือก"}
                </strong>
                {props.slipFile ? <p className="liffFileName">{props.slipFile.name}</p> : null}
                {props.uploadState.message ? <p>{props.uploadState.message}</p> : null}
                {typeof props.uploadState.progress === "number" ? (
                  <div className="liffProgress" aria-label={`อัปโหลด ${props.uploadState.progress}%`}>
                    <span style={{ width: `${props.uploadState.progress}%` }} />
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
          {props.uploadState.phase === "done" ? (
            // หลังส่งสลิปสำเร็จให้ดูสถานะใน LIFF โดยตรง เพราะบาง LIFF app ไม่มี chat_message.write
            <button
              className="btn primary liffPrimary"
              onClick={props.onViewStatus}
            >
              ✅ รับทราบ — ดูสถานะ
            </button>
          ) : (
            <button
              className="btn primary liffPrimary"
              disabled={!props.slipFile || props.uploadState.phase === "uploading" || props.busy}
              onClick={props.onUpload}
            >
              {props.uploadState.phase === "uploading" ? "กำลังอัปโหลด..." : "อัปโหลดสลิป"}
            </button>
          )}
        </>
      )}
      {(!uploadAllowed || isVerified) ? (
        // สำหรับกรณีที่เปิด LIFF มาแล้วสลิปอยู่ในสถานะรอตรวจหรือผ่านแล้ว
        <button className="btn primary liffPrimary" onClick={props.onViewStatus}>
          {isVerified ? "✅ ดูสถานะ" : "📋 ดูสถานะ"}
        </button>
      ) : null}
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
  onUploadSlip: (
    targetId: string,
    file: File,
    onProgress?: (progress: number) => void
  ) => Promise<SlipUploadResponse | null>;
}) {
  const [files, setFiles] = useState<Record<string, File | null>>({});
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [uploadStates, setUploadStates] = useState<Record<string, UploadState>>({});
  const previewsRef = useRef<Record<string, string>>({});
  const visiblePayments = props.payments.filter((payment) => payment.event);

  useEffect(() => {
    previewsRef.current = previews;
  }, [previews]);

  useEffect(() => {
    return () => {
      Object.values(previewsRef.current).forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  function setSlipForPayment(paymentId: string, file: File | null) {
    setFiles((current) => ({ ...current, [paymentId]: file }));
    setUploadStates((current) => ({
      ...current,
      [paymentId]: file
        ? { phase: "ready", message: "เลือกรูปสลิปแล้ว กดส่งสลิปเพื่ออัปโหลด" }
        : { phase: "idle" }
    }));
    setPreviews((current) => {
      if (current[paymentId]) URL.revokeObjectURL(current[paymentId]);
      if (!file) {
        const next = { ...current };
        delete next[paymentId];
        return next;
      }
      return { ...current, [paymentId]: URL.createObjectURL(file) };
    });
  }

  return (
    <section className="liffCard">
      {visiblePayments.length ? (
        <div className="paymentStatusList">
          {visiblePayments.map((payment) => {
            const latestSlip = payment.slips[0];
            const canUpload = canUploadSlip(payment.status);
            const uploadState = uploadStates[payment.id] ?? { phase: "idle" };
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
              {!canUpload && payment.status !== "verified" ? (
                <p className="muted">ระบบได้รับสลิปแล้ว ไม่ต้องอัปโหลดสลิปซ้ำระหว่างรอตรวจ</p>
              ) : null}
              {canUpload ? (
                <div className="statusUpload">
                  <label className="uploadButton miniUpload">
                    เลือกรูปสลิป
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(event) =>
                        setSlipForPayment(payment.id, event.target.files?.[0] ?? null)
                      }
                    />
                  </label>
                  {previews[payment.id] ? (
                    <div className={`statusSlipPreview ${uploadState.phase}`}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={previews[payment.id]} alt="รูปสลิปที่เลือก" />
                      <span className="fileName">{files[payment.id]?.name}</span>
                      {uploadState.message ? <small>{uploadState.message}</small> : null}
                      {typeof uploadState.progress === "number" ? (
                        <div className="liffProgress" aria-label={`อัปโหลด ${uploadState.progress}%`}>
                          <span style={{ width: `${uploadState.progress}%` }} />
                        </div>
                      ) : null}
                    </div>
                  ) : files[payment.id] ? (
                    <span className="fileName">{files[payment.id]?.name}</span>
                  ) : null}
                  <button
                    className="btn primary compactBtn"
                    disabled={!files[payment.id] || uploadState.phase === "uploading" || props.busy}
                    onClick={async () => {
                      const file = files[payment.id];
                      if (!file) return;
                      setUploadStates((current) => ({
                        ...current,
                        [payment.id]: { phase: "uploading", message: "กำลังเตรียมรูปสลิป...", progress: 2 }
                      }));
                      try {
                        const uploaded = await props.onUploadSlip(payment.id, file, (progress) => {
                          setUploadStates((current) => ({
                            ...current,
                            [payment.id]: { phase: "uploading", message: "กำลังอัปโหลดสลิป...", progress }
                          }));
                        });
                        setUploadStates((current) => ({
                          ...current,
                          [payment.id]: uploaded
                            ? {
                                phase: "done",
                                message: uploaded.message ?? "อัปโหลดสลิปเสร็จแล้ว รอผู้ดูแลตรวจสอบ",
                                progress: 100
                              }
                            : { phase: "error", message: "อัปโหลดสลิปไม่สำเร็จ กรุณาลองใหม่" }
                        }));
                      } catch (error) {
                        setUploadStates((current) => ({
                          ...current,
                          [payment.id]: {
                            phase: "error",
                            message: error instanceof Error ? error.message : String(error)
                          }
                        }));
                      }
                    }}
                  >
                    {uploadState.phase === "uploading"
                      ? "กำลังส่ง..."
                      : uploadState.phase === "done"
                        ? "ส่งแล้ว"
                        : "ส่งสลิป"}
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
