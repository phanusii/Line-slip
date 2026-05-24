"use client";

import {
  AlertTriangle,
  Archive,
  Bell,
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
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  Users,
  Volume2
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatBytes, formatMoney } from "@/lib/format";
import { statusLabels } from "@/lib/status";
import { RichMenuBuilder } from "@/components/RichMenuBuilder";

type Usage = {
  database: { used_bytes: number; limit_bytes: number };
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
  review_count: number;
  slip_count: number;
  storage_bytes: number;
};

type PendingCount = {
  count: number;
  latestSlipId: string | null;
  latestCreatedAt: string | null;
};

type LineQuota = {
  type: string;
  limit: number | null;
  used: number | null;
  remaining: number | null;
  canPush: boolean;
  checkedAt: string;
  error?: string;
};

type TelegramConnect = {
  bot?: { username?: string; first_name?: string };
  startUrl?: string;
  webhookUrl?: string;
  chats?: Array<{
    id: string;
    chat_id: string;
    chat_title: string | null;
    chat_type: string | null;
    enabled: boolean;
    last_seen_at: string;
  }>;
  hasBotToken?: boolean;
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
    payment_target_id: string | null;
    status: string;
    file_size: number;
    image_url: string | null;
    storage_path: string | null;
    file_deleted_at: string | null;
    duplicate_of_slip_id: string | null;
    replaced_by_slip_id: string | null;
    rejection_reason: string | null;
    amount_expected: number | null;
    amount_detected: number | null;
    auto_check_status: string | null;
    auto_check_reasons: string[] | null;
    auto_checked_at: string | null;
    ocr_result: {
      enabled?: boolean;
      available?: boolean;
      confidence?: number | null;
      amountMatched?: boolean | null;
      amounts?: number[];
      selectedAmount?: number | null;
      text?: string;
      error?: string;
    } | null;
    created_at: string;
    payment_targets: { display_name: string } | null;
  }>;
};

type CleanupMode = "files" | "files_and_metadata" | "event";
type SlipRow = EventDetail["slips"][number];
type PreviewSlip = { url: string; slip: SlipRow };

const exampleTargetsText = `สมชาย\t500
สมหญิง\t500
มานะ\t500`;

const uniqueTargetsText = `สมชาย
สมหญิง
มานะ`;

const cleanupModeLabels: Record<CleanupMode, string> = {
  files: "ลบเฉพาะรูปสลิป",
  files_and_metadata: "ลบรูปและข้อมูลสลิป",
  event: "ปิดงานและล้างข้อมูล"
};

const autoReasonLabels: Record<string, string> = {
  auto_verify_disabled: "ยังไม่เปิดตรวจอัตโนมัติ",
  missing_payment_target: "ไม่มีรายชื่อที่ผูกไว้",
  missing_slip_qr: "ไม่พบ QR บนสลิป",
  target_not_found: "ไม่พบรายชื่อ",
  target_status_verified: "รายชื่อนี้จ่ายแล้ว",
  target_status_deleted: "รายชื่อนี้ถูกลบแล้ว",
  target_not_selected_in_liff: "ยังไม่ได้เลือกชื่อผ่าน LIFF",
  line_user_mismatch: "LINE user ไม่ตรงกับผู้เลือกชื่อ",
  selection_window_expired: "เกินเวลาหลังสร้าง QR",
  amount_not_unique_in_event: "ยอดไม่ unique ในงานนี้",
  ocr_disabled: "ยังไม่ได้เปิด OCR",
  ocr_unavailable: "OCR ใช้งานไม่ได้",
  ocr_low_confidence: "OCR ไม่มั่นใจ",
  ocr_amount_missing: "OCR ไม่พบยอดทศนิยม 2 ตำแหน่ง",
  ocr_amount_mismatch: "OCR อ่านยอดไม่ตรง",
  free_auto_review_passed: "ผ่านทุกเงื่อนไข",
  duplicate_slip_qr: "QR สลิปซ้ำ",
  duplicate_image_hash: "รูปสลิปซ้ำ"
};

function percent(used: number, limit: number) {
  return Math.min(100, Math.round((used / limit) * 100));
}

function toneClass(value: number) {
  if (value >= 95) return "danger";
  if (value >= 85) return "danger";
  if (value >= 70) return "warn";
  return "";
}

function usageBadge(pct: number) {
  if (pct >= 95) return <span className="badge danger">เต็มวิกฤต {pct}%</span>;
  if (pct >= 85) return <span className="badge danger">ใกล้เต็มมาก {pct}%</span>;
  if (pct >= 70) return <span className="badge warn">ใกล้เต็ม {pct}%</span>;
  return null;
}

function settingEnabled(value: string | undefined, defaultValue = false) {
  if (value === undefined || value === "") return defaultValue;
  return value === "true" || value === "1" || value === "enabled";
}

function autoReasonText(reasons: string[] | null | undefined) {
  if (!reasons?.length) return "-";
  return reasons.map((reason) => autoReasonLabels[reason] ?? reason).join(", ");
}

function canReviewSlip(slip: SlipRow) {
  return (
    !slip.replaced_by_slip_id &&
    !["verified", "rejected", "deleted", "duplicate_slip"].includes(slip.status)
  );
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
  const [previewSlip, setPreviewSlip] = useState<PreviewSlip | null>(null);
  const [createEventOpen, setCreateEventOpen] = useState(false);
  const [newEventName, setNewEventName] = useState("");
  const [newPromptpayId, setNewPromptpayId] = useState("");
  const [newDefaultAmount, setNewDefaultAmount] = useState("");
  const [newTargetsText, setNewTargetsText] = useState(uniqueTargetsText);
  const [newUniqueAmountSuffix, setNewUniqueAmountSuffix] = useState(true);
  const [contactUrl, setContactUrl] = useState("");
  const [linePushPolicy, setLinePushPolicy] = useState("quota_aware");
  const [adminReviewChannel, setAdminReviewChannel] = useState("dashboard_only");
  const [autoVerifyFromSlipEnabled, setAutoVerifyFromSlipEnabled] = useState(false);
  const [autoVerifyWindowHours, setAutoVerifyWindowHours] = useState("24");
  const [autoVerifyRequiresUniqueAmount, setAutoVerifyRequiresUniqueAmount] = useState(true);
  const [autoVerifyOcrEnabled, setAutoVerifyOcrEnabled] = useState(false);
  const [telegramBotToken, setTelegramBotToken] = useState("");
  const [telegramChatId, setTelegramChatId] = useState("");
  const [telegramConnect, setTelegramConnect] = useState<TelegramConnect | null>(null);
  const [discordWebhookUrl, setDiscordWebhookUrl] = useState("");
  const [adminReviewTokenSecret, setAdminReviewTokenSecret] = useState("");
  const [adminReviewTokenTtlHours, setAdminReviewTokenTtlHours] = useState("24");
  const [lineQuota, setLineQuota] = useState<LineQuota | null>(null);
  const [pendingCount, setPendingCount] = useState<PendingCount | null>(null);
  const [lastPendingCount, setLastPendingCount] = useState<number | null>(null);
  const [notifyEnabled, setNotifyEnabled] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [contactUrlSaved, setContactUrlSaved] = useState(false);
  const [compactMenuPublished, setCompactMenuPublished] = useState(false);

  useEffect(() => {
    setOrigin(window.location.origin);
    setNotifyEnabled(localStorage.getItem("admin_notifications_enabled") === "1");
    void checkSession();
  }, []);

  useEffect(() => {
    if (!adminUser) return;
    void refreshPendingCount(false);
    const timer = window.setInterval(() => {
      void refreshPendingCount(true);
    }, 20000);
    return () => window.clearInterval(timer);
  }, [adminUser, notifyEnabled, lastPendingCount]);

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
      await Promise.all([loadAll(true), loadSettings()]);
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
      await Promise.all([loadAll(true), loadSettings()]);
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

  async function loadSettings() {
    try {
      const { settings } = await api<{ settings: Record<string, string> }>("/api/admin/settings");
      setContactUrl(settings.contact_url ?? "");
      setLinePushPolicy(settings.line_push_policy ?? "quota_aware");
      setAdminReviewChannel(settings.admin_review_channel ?? "dashboard_only");
      setAutoVerifyFromSlipEnabled(settingEnabled(settings.auto_verify_from_slip_enabled, false));
      setAutoVerifyWindowHours(settings.auto_verify_window_hours ?? "24");
      setAutoVerifyRequiresUniqueAmount(settingEnabled(settings.auto_verify_requires_unique_amount, true));
      setAutoVerifyOcrEnabled(settingEnabled(settings.auto_verify_ocr_enabled, false));
      setTelegramBotToken(settings.telegram_bot_token ?? "");
      setTelegramChatId(settings.telegram_chat_id ?? "");
      setDiscordWebhookUrl(settings.discord_webhook_url ?? "");
      setAdminReviewTokenSecret(settings.admin_review_token_secret ?? "");
      setAdminReviewTokenTtlHours(settings.admin_review_token_ttl_hours ?? "24");
      void loadTelegramConnect();
      void loadLineQuota();
    } catch {
      // non-critical
    }
  }

  async function saveSettings() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/admin/settings", {
        method: "POST",
        body: JSON.stringify({
          contact_url: contactUrl,
          line_push_policy: linePushPolicy,
          admin_review_channel: adminReviewChannel,
          auto_verify_from_slip_enabled: String(autoVerifyFromSlipEnabled),
          auto_verify_window_hours: autoVerifyWindowHours,
          auto_verify_requires_unique_amount: String(autoVerifyRequiresUniqueAmount),
          auto_verify_ocr_enabled: String(autoVerifyOcrEnabled),
          telegram_bot_token: telegramBotToken,
          telegram_chat_id: telegramChatId,
          discord_webhook_url: discordWebhookUrl,
          admin_review_token_secret: adminReviewTokenSecret,
          admin_review_token_ttl_hours: adminReviewTokenTtlHours
        })
      });
      setContactUrlSaved(true);
      await loadTelegramConnect();
      setTimeout(() => setContactUrlSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function loadLineQuota() {
    try {
      setLineQuota(await api<LineQuota>("/api/admin/line/quota"));
    } catch {
      // non-critical
    }
  }

  async function loadTelegramConnect() {
    try {
      setTelegramConnect(await api<TelegramConnect>("/api/admin/telegram/connect"));
    } catch {
      // non-critical
    }
  }

  async function createTelegramConnectLink() {
    setBusy(true);
    setError(null);
    try {
      const data = await api<TelegramConnect>("/api/admin/telegram/connect", {
        method: "POST",
        body: "{}"
      });
      setTelegramConnect(data);
      setToast("สร้างลิงก์เชื่อม Telegram แล้ว เปิดลิงก์และกด Start ในบอท");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function testTelegram() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/admin/telegram/test", { method: "POST", body: "{}" });
      setToast("ส่งข้อความทดสอบ Telegram แล้ว");
      await loadTelegramConnect();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function enableBrowserNotifications() {
    if (!("Notification" in window)) {
      setToast("Browser นี้ไม่รองรับ Notification");
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      localStorage.setItem("admin_notifications_enabled", "1");
      setNotifyEnabled(true);
      setToast("เปิดแจ้งเตือนบนเครื่องนี้แล้ว");
    } else {
      setToast("ยังไม่ได้อนุญาตแจ้งเตือนจาก browser");
    }
  }

  async function refreshPendingCount(shouldNotify: boolean) {
    try {
      const data = await api<PendingCount>("/api/admin/slips/pending-count");
      setPendingCount(data);
      if (lastPendingCount === null) {
        setLastPendingCount(data.count);
        return;
      }
      if (shouldNotify && data.count > lastPendingCount) {
        const message = `มีสลิปใหม่รอตรวจ ${data.count} รายการ`;
        setToast(message);
        document.title = `(${data.count}) สลิปรอตรวจ`;
        playNotifySound();
        if (notifyEnabled && "Notification" in window && Notification.permission === "granted") {
          new Notification("สลิปใหม่รอตรวจ", { body: message });
        }
        await loadAll(true);
      }
      setLastPendingCount(data.count);
    } catch {
      // non-critical polling
    }
  }

  function playNotifySound() {
    try {
      const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) return;
      const ctx = new AudioContextCtor();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.value = 0.03;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.18);
    } catch {
      // sound is optional
    }
  }

  async function publishCompactMenu() {
    setBusy(true);
    setError(null);
    setCompactMenuPublished(false);
    try {
      await api("/api/admin/rich-menu/compact", { method: "POST", body: "{}" });
      setCompactMenuPublished(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
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

  async function openSlip(slip: SlipRow) {
    const data = await api<{ signedUrl: string }>(
      `/api/admin/slips/${slip.id}/signed-url`,
      { method: "POST", body: "{}" }
    );
    setPreviewSlip({ url: data.signedUrl, slip });
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
            targets_text: newTargetsText,
            unique_amount_suffix: newUniqueAmountSuffix
          })
        }
      );
      setCreateEventOpen(false);
      setNewEventName("");
      setNewPromptpayId("");
      setNewDefaultAmount("");
      setNewTargetsText(uniqueTargetsText);
      setNewUniqueAmountSuffix(true);
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
  const dbPct = usage ? percent(usage.database.used_bytes, usage.database.limit_bytes) : 0;
  const paidCount = events.reduce((sum, event) => sum + event.paid_count, 0);
  const unpaidCount = events.reduce((sum, event) => sum + event.unpaid_count, 0);
  const pendingReviewTotal = pendingCount?.count ?? events.reduce((sum, event) => sum + (event.review_count ?? 0), 0);
  const totalDue = events.reduce((sum, event) => sum + Number(event.expected_total ?? 0), 0);
  const webhookUrl = `${origin || "https://your-domain.vercel.app"}/api/line/webhook`;
  const liffUrl = `${origin || "https://your-domain.vercel.app"}/liff`;
  type AdminNavItem = {
    value: string;
    label: string;
    icon: typeof Sparkles;
    badge?: number | null;
  };
  const navItems: AdminNavItem[] = [
    { value: "overview", label: "ภาพรวม", icon: Sparkles },
    { value: "events", label: "งานเก็บเงิน", icon: FileSpreadsheet },
    { value: "targets", label: "รายชื่อ", icon: Users },
    { value: "slips", label: "สลิป", icon: Bell, badge: pendingReviewTotal || null },
    { value: "auto", label: "ตรวจอัตโนมัติ", icon: ShieldCheck },
    { value: "storage", label: "พื้นที่/ล้างข้อมูล", icon: HardDrive },
    { value: "richmenu", label: "Rich Menu", icon: CheckCircle2 },
    { value: "line", label: "ตั้งค่า", icon: Settings }
  ];
  const targetRows =
    detail?.targets.filter((target) => {
      if (targetFilter === "paid") return target.status === "verified";
      if (targetFilter === "review") return target.status === "manual_review";
      if (targetFilter === "unpaid") return target.status !== "verified";
      return true;
    }) ?? [];
  const slipGroups = useMemo(() => {
    const groups = new Map<string, SlipRow[]>();
    for (const slip of detail?.slips ?? []) {
      const key = slip.payment_target_id ?? `slip:${slip.id}`;
      groups.set(key, [...(groups.get(key) ?? []), slip]);
    }

    return Array.from(groups.entries())
      .map(([key, slips]) => {
        const sorted = slips.sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
        const primary =
          sorted.find((slip) => !slip.replaced_by_slip_id && slip.status !== "duplicate_slip") ??
          sorted[0];
        const history = sorted.filter((slip) => slip.id !== primary.id);
        const hasProblem = sorted.some((slip) =>
          ["amount_mismatch", "duplicate_slip", "rejected"].includes(slip.status)
        );
        const hasDuplicate = sorted.some((slip) => slip.status === "duplicate_slip");
        const hasHistory =
          sorted.length > 1 || sorted.some((slip) => Boolean(slip.replaced_by_slip_id));

        return {
          key,
          primary,
          history,
          count: sorted.length,
          hasProblem,
          hasDuplicate,
          hasHistory
        };
      })
      .filter((group) => {
        if (slipFilter === "review") return group.primary.status === "manual_review";
        if (slipFilter === "paid") return group.primary.status === "verified";
        if (slipFilter === "duplicate") return group.hasDuplicate;
        if (slipFilter === "history") return group.hasHistory;
        if (slipFilter === "problem") return group.hasProblem;
        return true;
      });
  }, [detail?.slips, slipFilter]);

  return (
    <div className={adminUser ? "page adminAppPage" : "page"}>
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

        {toast ? (
          <section className="toastPanel">
            <Bell size={16} />
            <span>{toast}</span>
            <button className="iconButton" onClick={() => setToast(null)} aria-label="ปิดแจ้งเตือน">
              ปิด
            </button>
          </section>
        ) : null}

        {adminUser ? (
          <>
        <nav className="pageTabs" aria-label="เมนูหลังบ้าน">
          <div className="navTitle">
            <span>Admin</span>
            <strong>Line Slip</strong>
          </div>
          {navItems.map(({ value, label, icon: Icon, badge }) => (
            <button
              key={value}
              className={activePage === value ? "active" : ""}
              onClick={() => setActivePage(value)}
            >
              <Icon size={17} />
              <span>{label}</span>
              {badge ? <b>{badge}</b> : null}
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
          <div>
            <span>สลิปรอตรวจ</span>
            <strong>{pendingReviewTotal}</strong>
          </div>
        </section>

        <section className="grid" hidden={activePage !== "overview"}>
          <div className="panel stat accentReview">
            <div className="panelHeader">
              <h2>คิวสลิปรอตรวจ</h2>
              <Bell size={20} />
            </div>
            <strong>{pendingReviewTotal}</strong>
            <p className="muted">
              {pendingCount?.latestCreatedAt
                ? `ล่าสุด ${new Date(pendingCount.latestCreatedAt).toLocaleString("th-TH")}`
                : "ยังไม่มีสลิปรอตรวจ"}
            </p>
            <div className="actions">
              <button className="btn primary" onClick={() => setActivePage("slips")}>
                เปิดคิวตรวจ
              </button>
              <button className="btn subtle" onClick={enableBrowserNotifications}>
                <Volume2 size={15} />
                {notifyEnabled ? "เปิดแจ้งเตือนแล้ว" : "เปิดแจ้งเตือน"}
              </button>
            </div>
          </div>

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
            {usageBadge(storagePct)}
          </div>

          <div className="panel stat accentSky">
            <div className="panelHeader">
              <h2>ฐานข้อมูล</h2>
              <Archive size={20} />
            </div>
            <strong>{usage ? formatBytes(usage.database.used_bytes) : "-"}</strong>
            <p className="muted">
              ขนาดจริงจาก pg_database_size · ขีดจำกัด {usage ? formatBytes(usage.database.limit_bytes) : "-"}
            </p>
            <div className={`progress ${toneClass(dbPct)}`}>
              <span style={{ width: `${dbPct}%` }} />
            </div>
            {usageBadge(dbPct)}
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
          <div className="tableWrap desktopOnly">
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
          <div className="mobileCardList mobileOnly">
            {events.map((event) => (
              <article className="mobileRecordCard" key={event.id}>
                <div className="mobileRecordHeader">
                  <div>
                    <h3>{event.name}</h3>
                    <p>{event.slug}</p>
                  </div>
                  <span className={event.unpaid_count ? "badge warn" : "badge ok"}>
                    {event.unpaid_count ? "ยังไม่ครบ" : "ครบแล้ว"}
                  </span>
                </div>
                <div className="mobileMetricGrid">
                  <div>
                    <span>ยอดรวม</span>
                    <strong>{formatMoney(event.expected_total)}</strong>
                  </div>
                  <div>
                    <span>จ่ายแล้ว</span>
                    <strong>{event.paid_count}</strong>
                  </div>
                  <div>
                    <span>ยังไม่จ่าย</span>
                    <strong>{event.unpaid_count}</strong>
                  </div>
                  <div>
                    <span>สลิป</span>
                    <strong>{event.slip_count}</strong>
                  </div>
                </div>
                <div className="mobileActionGrid">
                  <button
                    className={selectedEventId === event.id ? "btn selected" : "btn subtle"}
                    onClick={() => selectEvent(event.id)}
                  >
                    เปิดงาน
                  </button>
                  <button
                    className="btn subtle"
                    onClick={() =>
                      authenticatedDownload(`/api/admin/events/${event.id}/export.csv`)
                    }
                  >
                    ไฟล์สรุป
                  </button>
                  <button
                    className="btn subtle"
                    onClick={() =>
                      authenticatedDownload(`/api/admin/events/${event.id}/slips.zip`)
                    }
                  >
                    ดาวน์โหลดสลิป
                  </button>
                  <button className="btn danger" onClick={() => setCleanup({ mode: "files", event })}>
                    ลบรูป
                  </button>
                </div>
              </article>
            ))}
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
              <div className="tableWrap desktopOnly">
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
              <div className="mobileCardList mobileOnly">
                {targetRows.map((target) => (
                  <article className="mobileRecordCard compactMobileCard" key={target.id}>
                    <div className="mobileRecordHeader">
                      <div>
                        <h3>{target.display_name}</h3>
                        <p>{formatMoney(target.amount_due)} บาท</p>
                      </div>
                      <span className={target.status === "verified" ? "badge ok" : "badge warn"}>
                        {statusLabels[target.status] ?? target.status}
                      </span>
                    </div>
                  </article>
                ))}
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
                  <p className="muted">ดูรูปสลิปแบบ gallery รวมสลิปล่าสุด สลิปซ้ำ และประวัติของแต่ละรายชื่อ</p>
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
                  ["duplicate", "สลิปซ้ำ"],
                  ["history", "ประวัติ/ถูกแทนที่"],
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
              <div className="slipGallery">
                {slipGroups.map((group) => {
                  const slip = group.primary;
                  const canOpen = Boolean(slip.storage_path && !slip.file_deleted_at);
                  return (
                    <article className="slipGalleryCard" key={group.key}>
                      <button
                        className="slipThumb"
                        disabled={!canOpen}
                        onClick={() => openSlip(slip)}
                        aria-label={`เปิดสลิปของ ${slip.payment_targets?.display_name ?? "ไม่ระบุชื่อ"}`}
                      >
                        {slip.image_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={slip.image_url} alt="รูปสลิป" />
                        ) : (
                          <span>{slip.file_deleted_at ? "ลบไฟล์แล้ว" : "ไม่มีรูป"}</span>
                        )}
                      </button>
                      <div className="slipGalleryBody">
                        <div className="slipGalleryTop">
                          <div>
                            <h3>{slip.payment_targets?.display_name ?? "-"}</h3>
                            <p>{new Date(slip.created_at).toLocaleString("th-TH")}</p>
                          </div>
                          <span className={slip.status === "verified" ? "badge ok" : "badge"}>
                            {slip.replaced_by_slip_id
                              ? "ถูกแทนที่"
                              : statusLabels[slip.status] ?? slip.status}
                          </span>
                        </div>
                        <div className="slipFacts">
                          <div>
                            <span>ยอด</span>
                            <strong>{formatMoney(slip.amount_expected)}</strong>
                          </div>
                          <div>
                            <span>OCR</span>
                            <strong>
                              {slip.amount_detected !== null ? formatMoney(slip.amount_detected) : "-"}
                            </strong>
                          </div>
                          <div>
                            <span>ไฟล์</span>
                            <strong>{formatBytes(slip.file_size)}</strong>
                          </div>
                        </div>
                        <p className="muted compactReason">
                          {slip.auto_check_status ?? "-"} · {autoReasonText(slip.auto_check_reasons)}
                        </p>
                        {group.count > 1 ? (
                          <details className="slipHistory">
                            <summary>มี {group.count} สลิปในกลุ่มนี้</summary>
                            <div>
                              {group.history.map((historySlip) => (
                                <button
                                  className="historySlip"
                                  key={historySlip.id}
                                  disabled={!historySlip.storage_path || Boolean(historySlip.file_deleted_at)}
                                  onClick={() => openSlip(historySlip)}
                                >
                                  {historySlip.image_url ? (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img src={historySlip.image_url} alt="ประวัติสลิป" />
                                  ) : (
                                    <span />
                                  )}
                                  <b>
                                    {historySlip.replaced_by_slip_id
                                      ? "ถูกแทนที่"
                                      : statusLabels[historySlip.status] ?? historySlip.status}
                                  </b>
                                  <small>{new Date(historySlip.created_at).toLocaleString("th-TH")}</small>
                                </button>
                              ))}
                            </div>
                          </details>
                        ) : null}
                        <div className="slipActions">
                          <button className="btn subtle" disabled={!canOpen} onClick={() => openSlip(slip)}>
                            <Eye size={15} />
                            เปิด
                          </button>
                          <button
                            className="btn subtle"
                            disabled={!canOpen}
                            onClick={() => authenticatedDownload(`/api/admin/slips/${slip.id}/download`)}
                          >
                            <Download size={15} />
                            โหลด
                          </button>
                          <button
                            className="btn subtle"
                            disabled={busy || !canReviewSlip(slip)}
                            onClick={() => updateSlipStatus(slip.id, "verified")}
                          >
                            อนุมัติ
                          </button>
                          <button
                            className="btn danger"
                            disabled={busy || !canReviewSlip(slip)}
                            onClick={() => updateSlipStatus(slip.id, "rejected")}
                          >
                            ปฏิเสธ
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
                {!slipGroups.length ? (
                  <div className="emptyState">
                    <strong>ยังไม่มีสลิปในตัวกรองนี้</strong>
                    <p>ลองเปลี่ยนตัวกรองหรือเลือกงานอื่นเพื่อดูสลิป</p>
                  </div>
                ) : null}
              </div>
            </div>
          </section>
        ) : null}

        <section className="panel" hidden={activePage !== "auto"}>
          <div className="panelHeader">
            <div>
              <h2>ตรวจสลิปอัตโนมัติจากรูป</h2>
              <p className="muted">
                ใช้ OCR อ่านยอดทศนิยม 2 ตำแหน่งร่วมกับ QR บนสลิป, hash กันซ้ำ และเวลาเลือก QR วิธีนี้ไม่ใช่การยืนยันจากธนาคาร
              </p>
            </div>
            <span className={autoVerifyFromSlipEnabled ? "badge warn" : "badge"}>
              {autoVerifyFromSlipEnabled ? "เปิดใช้งานแบบรับความเสี่ยง" : "ปิดอยู่"}
            </span>
          </div>

          <div className="warningBand">
            <AlertTriangle size={18} />
            <span>
              Auto verify นี้ตรวจจากหลักฐานในรูปเท่านั้น ถ้าต้องการยืนยันเงินจริง 100% ต้องใช้ statement หรือ bank API
            </span>
          </div>

          <div className="formGrid">
            <label className="checkField">
              <input
                type="checkbox"
                checked={autoVerifyFromSlipEnabled}
                onChange={(e) => setAutoVerifyFromSlipEnabled(e.target.checked)}
              />
              <span>เปิด auto verify จากรูปสลิป</span>
            </label>
            <label className="checkField">
              <input
                type="checkbox"
                checked={autoVerifyRequiresUniqueAmount}
                onChange={(e) => setAutoVerifyRequiresUniqueAmount(e.target.checked)}
              />
              <span>ยอดนี้ต้องตรงกับรายชื่อนี้ในงานนี้เท่านั้น</span>
            </label>
            <label className="checkField">
              <input
                type="checkbox"
                checked={autoVerifyOcrEnabled}
                onChange={(e) => setAutoVerifyOcrEnabled(e.target.checked)}
              />
              <span>เปิด OCR ฟรีเพื่อเช็กยอดทศนิยม 2 ตำแหน่ง</span>
            </label>
            <label className="field">
              <span>ช่วงเวลาหลังสร้าง QR (ชั่วโมง)</span>
              <input
                inputMode="numeric"
                value={autoVerifyWindowHours}
                onChange={(e) => setAutoVerifyWindowHours(e.target.value)}
                placeholder="24"
              />
            </label>
          </div>

          <div className="hintBox">
            <strong>เงื่อนไขที่ต้องผ่านทั้งหมด</strong>
            <p>
              ผู้ปกครองเลือกชื่อผ่าน LIFF, target ยังไม่จ่าย, รูปและ QR ไม่ซ้ำ, พบ QR บนสลิป,
              OCR อ่านยอดตรงแบบสตางค์เป๊ะ, ยอดไม่ซ้ำในงานเดียวกัน และส่งภายในเวลาที่ตั้งไว้
            </p>
          </div>

          <div className="actions panelActions">
            <button
              className="btn primary"
              disabled={!adminUser || adminUser.role !== "admin" || busy}
              onClick={saveSettings}
            >
              {contactUrlSaved ? "บันทึกแล้ว ✓" : "บันทึกตั้งค่า"}
            </button>
          </div>
        </section>

        <section className="panel" hidden={activePage !== "line"}>
          <div className="panelHeader">
            <div>
              <h2>ตั้งค่าการเชื่อมต่อ LINE</h2>
              <p className="muted">นำ Webhook URL นี้ไปใส่ใน LINE Developers และตั้งค่า Environment Variables บน Vercel</p>
            </div>
            <span className="badge ok">พร้อมใช้งาน Webhook</span>
          </div>

          <div className="setupCard" style={{ marginBottom: "1.5rem" }}>
            <span className="setupLabel">Rich Menu 4 ปุ่ม (สร้าง QR · ส่งสลิป · สถานะ · ติดต่อ)</span>
            <p className="muted" style={{ marginBottom: "0.75rem" }}>
              สร้างและเผยแพร่เมนู 2x2 โดยอัตโนมัติ ปุ่มติดต่อจะใช้ URL ที่ตั้งด้านล่าง
            </p>
            <div className="actions">
              <button
                className="btn primary"
                disabled={!adminUser || adminUser.role !== "admin" || busy}
                onClick={publishCompactMenu}
              >
                {busy ? "กำลังสร้าง…" : "สร้าง Rich Menu 4 ปุ่ม"}
              </button>
              {compactMenuPublished ? <span className="badge ok">เผยแพร่แล้ว ✓</span> : null}
            </div>
          </div>

          <div className="setupCard" style={{ marginBottom: "1.5rem" }}>
            <span className="setupLabel">ตั้งค่าการแจ้งเตือนและช่องทางแอดมิน</span>
            <div className="formGrid">
              <label className="field">
                <span>ลิงก์ปุ่มติดต่อ</span>
                <input
                  type="url"
                  value={contactUrl}
                  onChange={(e) => setContactUrl(e.target.value)}
                  placeholder="https://line.me/ti/p/~your_oa_id"
                />
              </label>
              <label className="field">
                <span>LINE push policy</span>
                <select value={linePushPolicy} onChange={(e) => setLinePushPolicy(e.target.value)}>
                  <option value="quota_aware">เช็กโควตาก่อน push</option>
                  <option value="disabled">ไม่ใช้ push</option>
                </select>
              </label>
              <label className="field">
                <span>ช่องทางตรวจสลิปแอดมิน</span>
                <select value={adminReviewChannel} onChange={(e) => setAdminReviewChannel(e.target.value)}>
                  <option value="dashboard_only">Dashboard เท่านั้น</option>
                  <option value="telegram">Telegram</option>
                  <option value="discord">Discord</option>
                </select>
              </label>
              <label className="field">
                <span>Token หมดอายุ (ชั่วโมง)</span>
                <input
                  inputMode="numeric"
                  value={adminReviewTokenTtlHours}
                  onChange={(e) => setAdminReviewTokenTtlHours(e.target.value)}
                  placeholder="24"
                />
              </label>
              <label className="field">
                <span>Telegram Bot Token</span>
                <input
                  value={telegramBotToken}
                  onChange={(e) => setTelegramBotToken(e.target.value)}
                  placeholder="เว้นว่างถ้าไม่เปลี่ยน"
                />
              </label>
              <label className="field">
                <span>Telegram Chat ID</span>
                <input
                  value={telegramChatId}
                  onChange={(e) => setTelegramChatId(e.target.value)}
                  placeholder="เชื่อมจากปุ่มด้านล่าง หรือใส่ -100xxxxxxxxxx"
                />
              </label>
              <label className="field">
                <span>Discord Webhook URL</span>
                <input
                  type="url"
                  value={discordWebhookUrl}
                  onChange={(e) => setDiscordWebhookUrl(e.target.value)}
                  placeholder="https://discord.com/api/webhooks/..."
                />
              </label>
              <label className="field">
                <span>External review secret</span>
                <input
                  value={adminReviewTokenSecret}
                  onChange={(e) => setAdminReviewTokenSecret(e.target.value)}
                  placeholder="เว้นว่างเพื่อใช้ ADMIN_SESSION_SECRET"
                />
              </label>
            </div>
            <div className="actions">
              <button
                className="btn primary"
                disabled={!adminUser || adminUser.role !== "admin" || busy}
                onClick={saveSettings}
              >
                {contactUrlSaved ? "บันทึกแล้ว ✓" : "บันทึกตั้งค่า"}
              </button>
              <button className="btn subtle" onClick={loadLineQuota}>
                เช็กโควตา LINE
              </button>
              {lineQuota ? (
                <span className={lineQuota.canPush ? "badge ok" : "badge warn"}>
                  {lineQuota.error
                    ? "เช็กโควตาไม่ได้"
                    : lineQuota.limit === null
                      ? `ใช้แล้ว ${lineQuota.used ?? "-"}`
                      : `เหลือ ${lineQuota.remaining} / ${lineQuota.limit}`}
                </span>
              ) : null}
            </div>
            <div className="hintBox" style={{ marginTop: "1rem" }}>
              <strong>Telegram Admin Bot</strong>
              <p>
                บันทึก Bot Token แล้วกดเชื่อม Telegram ระบบจะตั้ง webhook ให้เอง จากนั้นเปิดบอทและกด Start
                เพื่อผูกแชทนี้กับหลังบ้าน
              </p>
              <div className="actions">
                <button
                  className="btn primary"
                  disabled={!adminUser || adminUser.role !== "admin" || busy || !telegramBotToken}
                  onClick={createTelegramConnectLink}
                >
                  เชื่อม Telegram
                </button>
                <button
                  className="btn subtle"
                  disabled={!adminUser || adminUser.role !== "admin" || busy}
                  onClick={testTelegram}
                >
                  ทดสอบ Telegram
                </button>
                {telegramConnect?.startUrl ? (
                  <a className="btn subtle" href={telegramConnect.startUrl} target="_blank" rel="noreferrer">
                    เปิดบอท
                  </a>
                ) : null}
              </div>
              {telegramConnect?.bot?.username ? (
                <p className="muted">Bot: @{telegramConnect.bot.username}</p>
              ) : null}
              {telegramConnect?.webhookUrl ? (
                <p className="muted">Webhook: {telegramConnect.webhookUrl}</p>
              ) : null}
              {telegramConnect?.chats?.length ? (
                <div className="miniList">
                  {telegramConnect.chats.map((chat) => (
                    <span className="badge neutral" key={chat.id}>
                      {chat.chat_title || chat.chat_id}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="muted">ยังไม่มี Telegram chat ที่เชื่อมแล้ว</p>
              )}
              <p className="muted">
                หลังเชื่อมแล้ว Telegram จะแสดงปุ่มลัดด้านล่าง: งานทั้งหมด, สลิปรอตรวจ, สลิปล่าสุด และช่วยเหลือ
              </p>
            </div>
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
                กด &quot;สร้าง Rich Menu Compact&quot; เพื่อเผยแพร่เมนู,
                เพิ่ม LINE OA เป็นเพื่อน แล้วเลือกชื่อก่อนส่งสลิป
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
          </>
        ) : (
          <section className="panel">
            <div className="panelHeader">
              <div>
                <h2>{authChecking ? "กำลังตรวจสอบเซสชัน" : "กรุณาเข้าสู่ระบบ"}</h2>
                <p className="muted">
                  ข้อมูลหลังบ้าน รายชื่อ ยอดเงิน สลิป และการตั้งค่า LINE จะแสดงหลังยืนยันตัวตนผู้ดูแลเท่านั้น
                </p>
              </div>
              <span className="badge">Protected</span>
            </div>
          </section>
        )}
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
                วางรายชื่อจาก Google Sheets หรือ Excel ได้เลย ถ้ายอดเท่ากันทุกคนให้กรอกยอดกลาง
                แล้วระบบจะเติมเศษสตางค์เฉพาะรายชื่อ เช่น 500.01, 500.02
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

            <label className="checkField">
              <input
                type="checkbox"
                checked={newUniqueAmountSuffix}
                onChange={(event) => setNewUniqueAmountSuffix(event.target.checked)}
              />
              <span>เติมเศษสตางค์เฉพาะรายชื่อจากยอดกลาง</span>
            </label>

            <label className="field">
              <span>รายชื่อและยอดเงิน</span>
              <textarea
                rows={8}
                value={newTargetsText}
                onChange={(event) => setNewTargetsText(event.target.value)}
                placeholder={"สมชาย\nสมหญิง\nมานะ"}
              />
            </label>

            <div className="hintBox">
              <strong>รูปแบบที่รองรับ</strong>
              <p>
                แนะนำวางเฉพาะรายชื่อทีละบรรทัดและกรอกยอดกลาง เช่น 500 เพื่อให้ระบบสร้างยอด 500.01-500.35
                ส่วนรูปแบบเดิม สมชาย 500 หรือ สมชาย[TAB]500 ยังใช้ได้
              </p>
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

      {previewSlip ? (
        <div className="modalBackdrop" onClick={() => setPreviewSlip(null)}>
          <div className="slipPreviewModal" onClick={(event) => event.stopPropagation()}>
            <div className="slipPreviewHeader">
              <div>
                <h3>{previewSlip.slip.payment_targets?.display_name ?? "สลิป"}</h3>
                <p className="muted">
                  {formatMoney(previewSlip.slip.amount_expected)} บาท ·{" "}
                  {statusLabels[previewSlip.slip.status] ?? previewSlip.slip.status}
                </p>
              </div>
              <button className="iconButton" onClick={() => setPreviewSlip(null)} aria-label="ปิดตัวอย่างสลิป">
                ปิด
              </button>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="preview" src={previewSlip.url} alt="ตัวอย่างสลิป" />
            <div className="actions modalActions">
              <button
                className="btn subtle"
                onClick={() => authenticatedDownload(`/api/admin/slips/${previewSlip.slip.id}/download`)}
              >
                <Download size={15} />
                ดาวน์โหลด
              </button>
              <button
                className="btn subtle"
                disabled={busy || !canReviewSlip(previewSlip.slip)}
                onClick={() => updateSlipStatus(previewSlip.slip.id, "verified")}
              >
                อนุมัติ
              </button>
              <button
                className="btn danger"
                disabled={busy || !canReviewSlip(previewSlip.slip)}
                onClick={() => updateSlipStatus(previewSlip.slip.id, "rejected")}
              >
                ปฏิเสธ
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
