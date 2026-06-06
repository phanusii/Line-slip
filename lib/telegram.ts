import crypto from "node:crypto";
import { appBaseUrl, formatThaiDateTime, getLineMessageQuota } from "@/lib/line";
import { getSettings, SettingsMap } from "@/lib/settings";
import { applySlipStatus } from "@/lib/slip-status";
import { getSlipOkQuota, getSlipOkUsedThisMonth } from "@/lib/slipok";
import { createServiceClient } from "@/lib/supabase/server";

type TelegramAction = "verified" | "rejected";
type EventMenuAction = "targets" | "slips" | "unpaid";
type TargetFilter = "all" | "unpaid" | "paid";

const telegramButtons = {
  events: "📋 งานทั้งหมด",
  pending: "🔔 รอตรวจ",
  latest: "🧾 สลิปล่าสุด",
  unpaid: "⏳ ค้างจ่าย",
  paid: "✅ จ่ายแล้ว",
  web: "🌐 เว็บ"
} as const;

const targetPageSize = 12;
const telegramMessageLimit = 3900;

type TelegramChat = {
  id: number | string;
  type?: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
};

type TelegramMessage = {
  message_id?: number;
  text?: string;
  chat: TelegramChat;
  from?: {
    id: number;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
};

type TelegramCallbackQuery = {
  id: string;
  data?: string;
  message?: TelegramMessage;
  from?: {
    id: number;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
};

export type TelegramUpdate = {
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

function base64Url(input: string | Buffer) {
  return Buffer.from(input).toString("base64url");
}

function tokenSecret(settings: SettingsMap) {
  return (
    settings.admin_review_token_secret ||
    process.env.ADMIN_REVIEW_TOKEN_SECRET ||
    process.env.ADMIN_SESSION_SECRET ||
    "line-slip-review-dev-secret"
  );
}

function signBody(body: string, settings: SettingsMap) {
  return crypto.createHmac("sha256", tokenSecret(settings)).update(body).digest("base64url");
}

function mainKeyboard() {
  return {
    keyboard: [
      [telegramButtons.events, telegramButtons.pending],
      [telegramButtons.latest, telegramButtons.unpaid],
      [telegramButtons.paid, telegramButtons.web]
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "เลือกเมนู"
  };
}

function messageWithMainKeyboard(payload: Record<string, unknown>) {
  return {
    ...payload,
    reply_markup: mainKeyboard()
  };
}

function compactName(user?: TelegramMessage["from"]) {
  return user?.username
    ? `@${user.username}`
    : [user?.first_name, user?.last_name].filter(Boolean).join(" ") || "telegram-admin";
}

function chatTitle(chat: TelegramChat) {
  return chat.title ?? chat.username ?? ([chat.first_name, chat.last_name].filter(Boolean).join(" ") || String(chat.id));
}

function formatTelegramLineQuota(quota: Awaited<ReturnType<typeof getLineMessageQuota>> | null) {
  if (!quota) return null;
  if (quota.type === "none") {
    return `📨 โควตา LINE: ไม่จำกัด (ใช้แล้ว ${quota.used.toLocaleString("th-TH")})`;
  }
  return `📨 โควตา LINE: เหลือ ${Number(quota.remaining ?? 0).toLocaleString("th-TH")}/${Number(quota.limit ?? 0).toLocaleString("th-TH")} ข้อความ (ใช้แล้ว ${quota.used.toLocaleString("th-TH")})`;
}

function formatTelegramSlipOkQuota(input: {
  quota: Awaited<ReturnType<typeof getSlipOkQuota>> | null;
  usedThisMonth: number | null;
}) {
  if (!input.quota) return null;
  if (!input.quota.ok) {
    return `🧾 โควตา SlipOK: เช็กไม่ได้ (${input.quota.error ?? "ไม่ทราบสาเหตุ"})`;
  }
  const remaining = input.quota.remaining ?? input.quota.quota ?? null;
  const used = input.usedThisMonth ?? 0;
  const overQuota = Number(input.quota.overQuota ?? 0);
  return [
    `🧾 โควตา SlipOK: เหลือ ${remaining === null ? "ไม่ทราบ" : remaining.toLocaleString("th-TH")} สลิป`,
    `ใช้ในระบบเดือนนี้ ${used.toLocaleString("th-TH")} สลิป`,
    overQuota > 0 ? `overQuota ${overQuota.toLocaleString("th-TH")}` : null
  ].filter(Boolean).join(" · ");
}

function slipIdToHex(slipId: string) {
  return slipId.replaceAll("-", "").toLowerCase();
}

function slipHexToUuid(hex: string) {
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error("รหัสสลิปจาก Telegram ไม่ถูกต้อง");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function actionCode(action: TelegramAction) {
  return action === "verified" ? "v" : "r";
}

function actionFromCode(code: string): TelegramAction {
  if (code === "v") return "verified";
  if (code === "r") return "rejected";
  throw new Error("คำสั่งตรวจสลิปจาก Telegram ไม่ถูกต้อง");
}

function signTelegramReviewCallback(input: {
  slipId: string;
  action: TelegramAction;
  settings: SettingsMap;
}) {
  const ttlHours = Number(input.settings.admin_review_token_ttl_hours || 24);
  const expiresAtMinute = Math.floor(Date.now() / 60000) + Math.max(1, ttlHours) * 60;
  const body = `${actionCode(input.action)}:${slipIdToHex(input.slipId)}:${expiresAtMinute.toString(36)}`;
  const signature = signBody(body, input.settings).slice(0, 12);
  return `r:${body}:${signature}`;
}

function verifyTelegramReviewCallback(token: string, settings: SettingsMap) {
  const [prefix, action, slipHex, exp36, signature] = token.split(":");
  if (prefix !== "r" || !action || !slipHex || !exp36 || !signature) {
    throw new Error("ปุ่มตรวจสลิปไม่ถูกต้อง");
  }

  const body = `${action}:${slipHex}:${exp36}`;
  const expected = signBody(body, settings).slice(0, 12);
  const actualSignature = Buffer.from(signature);
  const expectedSignature = Buffer.from(expected);
  if (
    actualSignature.length !== expectedSignature.length ||
    !crypto.timingSafeEqual(actualSignature, expectedSignature)
  ) {
    throw new Error("ปุ่มตรวจสลิปไม่ถูกต้อง");
  }

  const expiresAtMinute = Number.parseInt(exp36, 36);
  if (!Number.isFinite(expiresAtMinute) || Math.floor(Date.now() / 60000) > expiresAtMinute) {
    throw new Error("ปุ่มตรวจสลิปหมดอายุแล้ว กรุณาตรวจจาก dashboard");
  }

  return {
    slipId: slipHexToUuid(slipHex),
    action: actionFromCode(action)
  };
}

function signEventMenuCallback(input: {
  eventId: string;
  action: EventMenuAction;
  filter?: TargetFilter;
  settings: SettingsMap;
}) {
  const body = `ev:${slipIdToHex(input.eventId)}:${input.action}${input.filter ? `:${input.filter}` : ""}`;
  return `${body}:${signBody(body, input.settings).slice(0, 8)}`;
}

function signEventPageCallback(input: {
  eventId: string;
  type: "targets";
  filter: TargetFilter;
  page: number;
  settings: SettingsMap;
}) {
  const body = `page:${input.type}:${slipIdToHex(input.eventId)}:${input.filter}:${input.page.toString(36)}`;
  return `${body}:${signBody(body, input.settings).slice(0, 8)}`;
}

function verifySignedCallback(data: string, settings: SettingsMap) {
  const parts = data.split(":");
  if (parts.length < 3) throw new Error("ปุ่ม Telegram ไม่ถูกต้อง");
  const signature = parts.at(-1);
  const body = parts.slice(0, -1).join(":");
  if (!signature) throw new Error("ปุ่ม Telegram ไม่ถูกต้อง");

  const expected = signBody(body, settings).slice(0, 8);
  const actualSignature = Buffer.from(signature);
  const expectedSignature = Buffer.from(expected);
  if (
    actualSignature.length !== expectedSignature.length ||
    !crypto.timingSafeEqual(actualSignature, expectedSignature)
  ) {
    throw new Error("ปุ่ม Telegram ไม่ถูกต้อง");
  }

  if (parts[0] === "ev" && (parts.length === 4 || parts.length === 5)) {
    const action = parts[2];
    const filter = parts.length === 5 ? parts[3] : undefined;
    if (action !== "targets" && action !== "slips" && action !== "unpaid") throw new Error("เมนู Telegram ไม่ถูกต้อง");
    if (filter && filter !== "all" && filter !== "unpaid" && filter !== "paid") throw new Error("ตัวกรอง Telegram ไม่ถูกต้อง");
    return {
      kind: "event" as const,
      eventId: slipHexToUuid(parts[1]),
      action,
      filter: (filter ?? (action === "unpaid" ? "unpaid" : "all")) as TargetFilter
    };
  }

  if (parts[0] === "page" && parts.length === 6) {
    const type = parts[1];
    if (type !== "targets") throw new Error("หน้า Telegram ไม่ถูกต้อง");
    const filter = parts[3];
    if (filter !== "all" && filter !== "unpaid" && filter !== "paid") throw new Error("ตัวกรอง Telegram ไม่ถูกต้อง");
    const page = Number.parseInt(parts[4], 36);
    if (!Number.isFinite(page) || page < 0) throw new Error("หน้า Telegram ไม่ถูกต้อง");
    return {
      kind: "page" as const,
      type,
      eventId: slipHexToUuid(parts[2]),
      filter: filter as TargetFilter,
      page
    };
  }

  throw new Error("ปุ่ม Telegram ไม่ถูกต้อง");
}

export function signTelegramConnectToken(input: {
  adminEmail: string;
  settings: SettingsMap;
}) {
  const payload = {
    adminEmail: input.adminEmail,
    exp: Date.now() + 30 * 60 * 1000
  };
  const body = base64Url(JSON.stringify(payload));
  return `${body}.${signBody(body, input.settings)}`;
}

export async function verifyTelegramConnectToken(token: string) {
  const settings = await getSettings(["admin_review_token_secret"]);
  const [body, signature] = token.split(".");
  if (!body || !signature) throw new Error("ลิงก์เชื่อม Telegram ไม่ถูกต้อง");

  const expected = signBody(body, settings);
  const actualSignature = Buffer.from(signature);
  const expectedSignature = Buffer.from(expected);
  if (
    actualSignature.length !== expectedSignature.length ||
    !crypto.timingSafeEqual(actualSignature, expectedSignature)
  ) {
    throw new Error("ลิงก์เชื่อม Telegram ไม่ถูกต้อง");
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
    adminEmail: string;
    exp: number;
  };
  if (!payload.adminEmail || Date.now() > payload.exp) {
    throw new Error("ลิงก์เชื่อม Telegram หมดอายุแล้ว");
  }
  return payload;
}

export async function callTelegram<T = unknown>(
  settings: SettingsMap,
  method: string,
  payload: Record<string, unknown>
) {
  if (!settings.telegram_bot_token) throw new Error("ยังไม่ได้ตั้งค่า Telegram Bot Token");

  const response = await fetch(`https://api.telegram.org/bot${settings.telegram_bot_token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = (await response.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string } | null;
  if (!response.ok || !data?.ok) {
    throw new Error(data?.description ?? `Telegram API error: ${response.status}`);
  }
  return data.result as T;
}

export async function getTelegramBotInfo(settings: SettingsMap) {
  return callTelegram<{ username?: string; first_name?: string }>(settings, "getMe", {});
}

export async function ensureTelegramWebhook(settings: SettingsMap) {
  if (!settings.telegram_webhook_secret) {
    settings.telegram_webhook_secret = crypto.randomBytes(24).toString("base64url");
    const supabase = createServiceClient();
    await supabase.from("settings").upsert({
      key: "telegram_webhook_secret",
      value: settings.telegram_webhook_secret,
      updated_at: new Date().toISOString()
    });
  }

  return callTelegram(settings, "setWebhook", {
    url: `${appBaseUrl()}/api/telegram/webhook`,
    secret_token: settings.telegram_webhook_secret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false
  });
}

export async function getConnectedTelegramChats() {
  const settings = await getSettings(["telegram_chat_id"]);
  if (!settings.telegram_chat_id) return [];
  return [
    {
      id: settings.telegram_chat_id,
      chat_id: settings.telegram_chat_id,
      chat_title: settings.telegram_chat_id,
      chat_type: null,
      enabled: true,
      last_seen_at: new Date().toISOString()
    }
  ];
}

export async function bindTelegramChat(input: {
  chat: TelegramChat;
  adminEmail: string;
  from?: TelegramMessage["from"];
}) {
  const supabase = createServiceClient();
  const now = new Date().toISOString();
  const chatId = String(input.chat.id);

  await supabase.from("settings").upsert([
    { key: "telegram_chat_id", value: chatId, updated_at: now },
    { key: "admin_review_channel", value: "telegram", updated_at: now }
  ]);

  await supabase.from("audit_logs").insert({
    actor_email: input.adminEmail,
    actor_role: "admin",
    action: "telegram_chat_connected",
    entity_type: "settings",
    after_data: {
      chat_id: chatId,
      chat_type: input.chat.type ?? null,
      chat_title: chatTitle(input.chat),
      telegram_user: compactName(input.from)
    },
    reason: "เชื่อม Telegram admin chat จาก bot start link"
  });
}

export async function sendTelegramSlipReview(input: {
  settings: SettingsMap;
  slipId: string;
  text: string;
  imageUrl: string | null;
  dashboardUrl: string;
  chatIds?: string[];
}) {
  const chats = input.chatIds ? [] : await getConnectedTelegramChats().catch(() => []);
  const chatIds =
    input.chatIds ??
    (chats.length
      ? chats.map((chat) => chat.chat_id)
      : input.settings.telegram_chat_id
        ? [input.settings.telegram_chat_id]
        : []);

  if (!chatIds.length) throw new Error("ยังไม่ได้เชื่อม Telegram chat");

  const approveToken = signTelegramReviewCallback({
    slipId: input.slipId,
    action: "verified",
    settings: input.settings
  });
  const rejectToken = signTelegramReviewCallback({
    slipId: input.slipId,
    action: "rejected",
    settings: input.settings
  });
  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "อนุมัติ", callback_data: approveToken },
        { text: "ปฏิเสธ", callback_data: rejectToken }
      ],
      [{ text: "เปิดในเว็บ", url: input.dashboardUrl }]
    ]
  };

  for (const chatId of chatIds) {
    if (input.imageUrl) {
      await callTelegram(input.settings, "sendPhoto", {
        chat_id: chatId,
        photo: input.imageUrl,
        caption: input.text,
        reply_markup: replyMarkup
      });
    } else {
      await callTelegram(input.settings, "sendMessage", {
        chat_id: chatId,
        text: input.text,
        reply_markup: replyMarkup
      });
    }
  }
}

export async function sendTelegramTestMessage(settings: SettingsMap) {
  const chats = await getConnectedTelegramChats().catch(() => []);
  const chatIds = chats.length
    ? chats.map((chat) => chat.chat_id)
    : settings.telegram_chat_id
      ? [settings.telegram_chat_id]
      : [];
  if (!chatIds.length) throw new Error("ยังไม่ได้เชื่อม Telegram chat");

  for (const chatId of chatIds) {
    await callTelegram(settings, "sendMessage", messageWithMainKeyboard({
      chat_id: chatId,
      text: "ทดสอบ Telegram สำเร็จ: ระบบพร้อมแจ้งเตือนสลิปและตรวจจากปุ่มในแชท"
    }));
  }
}

export async function handleTelegramWebhook(update: TelegramUpdate) {
  if (update.callback_query) {
    await handleTelegramCallback(update.callback_query);
    return;
  }
  if (update.message?.text) {
    await handleTelegramCommand(update.message);
  }
}

async function handleTelegramCallback(callback: TelegramCallbackQuery) {
  const settings = await getSettings();
  if (!callback.data) return;
  const chatId = callback.message?.chat ? String(callback.message.chat.id) : null;
  if (!chatId || !(await isTrustedChat(chatId, settings))) {
    await callTelegram(settings, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "แชทนี้ไม่มีสิทธิ์ตรวจสลิป",
      show_alert: true
    }).catch(() => null);
    return;
  }

  if (callback.data.startsWith("ev:") || callback.data.startsWith("page:")) {
    await handleTelegramMenuCallback(callback, chatId, settings);
    return;
  }

  if (!callback.data.startsWith("r:")) return;

  await callTelegram(settings, "answerCallbackQuery", {
    callback_query_id: callback.id,
    text: "กำลังบันทึกผลตรวจ..."
  }).catch(() => null);

  let reviewAction: { slipId: string; action: TelegramAction };
  try {
    reviewAction = verifyTelegramReviewCallback(callback.data, settings);
  } catch (error) {
    await callTelegram(settings, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: error instanceof Error ? error.message : "ปุ่มนี้หมดอายุหรือถูกใช้งานแล้ว",
      show_alert: true
    }).catch(() => null);
    return;
  }

  const action = reviewAction.action;

  try {
    await applySlipStatus({
      slipId: reviewAction.slipId,
      status: action,
      reason: action === "verified" ? "อนุมัติจาก Telegram" : "ปฏิเสธจาก Telegram",
      actor: {
        actor_email: compactName(callback.from),
        actor_role: "admin"
      },
      auditAction: action === "verified" ? "telegram_review_approved" : "telegram_review_rejected",
      source: "telegram"
    });
  } catch (error) {
    // ลบปุ่มออกแม้จะมี error — กรณีพบบ่อย: สลิปถูกตรวจไปแล้ว
    if (callback.message?.chat?.id && callback.message.message_id) {
      await callTelegram(settings, "editMessageReplyMarkup", {
        chat_id: callback.message.chat.id,
        message_id: callback.message.message_id,
        reply_markup: { inline_keyboard: [] }
      }).catch(() => null);
    }
    await callTelegram(settings, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: error instanceof Error ? error.message : "เกิดข้อผิดพลาด",
      show_alert: true
    }).catch(() => null);
    return;
  }

  // ลบปุ่มออกจากข้อความสลิปเดิม + ดึงโควตา LINE/SlipOK พร้อมกัน
  const [, quota, slipOkQuota, slipOkUsedThisMonth] = await Promise.all([
    callback.message?.chat?.id && callback.message.message_id
      ? callTelegram(settings, "editMessageReplyMarkup", {
          chat_id: callback.message.chat.id,
          message_id: callback.message.message_id,
          reply_markup: { inline_keyboard: [] }
        }).catch(() => null)
      : Promise.resolve(null),
    getLineMessageQuota().catch(() => null),
    getSlipOkQuota(settings).catch(() => null),
    getSlipOkUsedThisMonth().catch(() => null)
  ]);

  const text = action === "verified" ? "อนุมัติสลิปแล้ว" : "ปฏิเสธสลิปแล้ว";
  await callTelegram(settings, "answerCallbackQuery", {
    callback_query_id: callback.id,
    text
  }).catch(() => null);

  if (callback.message?.chat?.id) {
    const quotaLine = formatTelegramLineQuota(quota);
    const slipOkLine = formatTelegramSlipOkQuota({
      quota: slipOkQuota,
      usedThisMonth: slipOkUsedThisMonth
    });
    const lines = [`${text} โดย ${compactName(callback.from)}`, quotaLine, slipOkLine].filter(Boolean);
    await callTelegram(settings, "sendMessage", {
      chat_id: callback.message.chat.id,
      text: lines.join("\n")
    }).catch(() => null);
  }
}

async function handleTelegramMenuCallback(
  callback: TelegramCallbackQuery,
  chatId: string,
  settings: SettingsMap
) {
  let menuAction: ReturnType<typeof verifySignedCallback>;
  try {
    menuAction = verifySignedCallback(callback.data ?? "", settings);
  } catch (error) {
    await callTelegram(settings, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: error instanceof Error ? error.message : "ปุ่มนี้ไม่ถูกต้อง",
      show_alert: true
    }).catch(() => null);
    return;
  }

  await callTelegram(settings, "answerCallbackQuery", {
    callback_query_id: callback.id,
    text: "กำลังโหลดข้อมูล..."
  }).catch(() => null);

  if (menuAction.kind === "event" && menuAction.action === "targets") {
    await sendTargetsListByEvent(chatId, settings, menuAction.eventId, menuAction.filter, 0);
    return;
  }
  if (menuAction.kind === "event" && menuAction.action === "unpaid") {
    await sendTargetsListByEvent(chatId, settings, menuAction.eventId, "unpaid", 0);
    return;
  }
  if (menuAction.kind === "event" && menuAction.action === "slips") {
    await sendSlipsList(chatId, settings, "event", menuAction.eventId);
    return;
  }
  if (menuAction.kind === "page") {
    await sendTargetsListByEvent(chatId, settings, menuAction.eventId, menuAction.filter, menuAction.page);
  }
}

async function handleTelegramCommand(message: TelegramMessage) {
  const settings = await getSettings();
  const chatId = String(message.chat.id);
  const text = message.text?.trim() ?? "";
  const [command, ...args] = text.split(/\s+/);

  if (command === "/start" && args[0]?.startsWith("connect_")) {
    const token = args[0].slice("connect_".length);
    const payload = await verifyTelegramConnectToken(token);
    await bindTelegramChat({ chat: message.chat, adminEmail: payload.adminEmail, from: message.from });
    await callTelegram(settings, "sendMessage", messageWithMainKeyboard({
      chat_id: chatId,
      text: "เชื่อม Telegram สำเร็จแล้ว ใช้ปุ่มด้านล่างเพื่อดูงาน ดูสลิป และตรวจสลิปได้ทันที"
    }));
    return;
  }

  const allowed = await isTrustedChat(chatId, settings);
  if (!allowed) {
    await callTelegram(settings, "sendMessage", {
      chat_id: chatId,
      text: "แชทนี้ยังไม่ได้เชื่อมกับระบบ กรุณาเชื่อมจากหน้าเว็บหลังบ้านก่อน"
    });
    return;
  }

  if (command === "/start" || command === "/help") {
    await callTelegram(settings, "sendMessage", messageWithMainKeyboard({
      chat_id: chatId,
      text: [
        "ยินดีต้อนรับ! เลือกเมนูจากปุ่มด้านล่างได้เลย 👇",
        `${telegramButtons.events} ดูงานทั้งหมด`,
        `${telegramButtons.pending} สลิปรอตรวจ`,
        `${telegramButtons.latest} สลิปล่าสุด`,
        `${telegramButtons.unpaid} รายการค้างจ่าย`,
        `${telegramButtons.paid} รายการจ่ายแล้ว`,
        `${telegramButtons.web} เปิดหน้าเว็บหลังบ้าน`
      ].join("\n")
    }));
    return;
  }

  if (command === "/events" || text === telegramButtons.events) {
    await sendEventsList(chatId, settings);
    return;
  }
  if (command === "/targets") {
    await sendTargetsList(chatId, settings, args.join(" "));
    return;
  }
  if (command === "/pending" || text === telegramButtons.pending) {
    await sendSlipsList(chatId, settings, "pending");
    return;
  }
  if (command === "/slips" || text === telegramButtons.latest) {
    await sendSlipsList(chatId, settings, "latest");
    return;
  }
  if (text === telegramButtons.unpaid) {
    await sendCrossEventTargetSummary(chatId, settings, "unpaid");
    return;
  }
  if (text === telegramButtons.paid) {
    await sendCrossEventTargetSummary(chatId, settings, "paid");
    return;
  }
  if (text === telegramButtons.web) {
    await callTelegram(settings, "sendMessage", {
      chat_id: chatId,
      text: "เปิดหน้าเว็บหลังบ้านได้เลย 👇",
      reply_markup: {
        inline_keyboard: [[{ text: "🌐 เปิดเว็บ", url: appBaseUrl() }]]
      }
    });
    return;
  }
}

async function isTrustedChat(chatId: string, settings: SettingsMap) {
  return settings.telegram_chat_id === chatId;
}



function targetFilterLabel(filter: TargetFilter) {
  if (filter === "paid") return "จ่ายแล้ว";
  if (filter === "unpaid") return "ค้างจ่าย";
  return "ทั้งหมด";
}

function splitTelegramText(lines: string[]) {
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > telegramMessageLimit && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function sendCrossEventTargetSummary(
  chatId: string,
  settings: SettingsMap,
  filter: Exclude<TargetFilter, "all">
) {
  const supabase = createServiceClient();
  let query = supabase
    .from("payment_targets")
    .select("event_id,display_name,amount_due,status,events(id,name)")
    .neq("status", "deleted")
    .order("updated_at", { ascending: false })
    .limit(30);

  query = filter === "paid" ? query.eq("status", "verified") : query.neq("status", "verified");

  const { data, error } = await query;
  if (error) throw error;
  if (!data?.length) {
    await callTelegram(settings, "sendMessage", messageWithMainKeyboard({
      chat_id: chatId,
      text: filter === "paid" ? "ยังไม่มีรายการจ่ายแล้ว" : "ไม่มีรายการค้างจ่าย"
    }));
    return;
  }

  const eventMap = new Map<string, { id: string; name: string; count: number; total: number }>();
  for (const target of data) {
    const eventRow = Array.isArray(target.events) ? target.events[0] : target.events;
    const eventId = target.event_id;
    const current = eventMap.get(eventId) ?? {
      id: eventId,
      name: eventRow?.name ?? "ไม่พบชื่องาน",
      count: 0,
      total: 0
    };
    current.count += 1;
    current.total += Number(target.amount_due ?? 0);
    eventMap.set(eventId, current);
  }

  const events = Array.from(eventMap.values()).slice(0, 10);
  const lines = events.map(
    (event) => `• ${event.name} - ${event.count} รายชื่อ - ${event.total.toLocaleString("th-TH")} บาท`
  );
  const inlineKeyboard = events.map((event) => [
    {
      text: `${targetFilterLabel(filter)}: ${event.name}`.slice(0, 58),
      callback_data: signEventMenuCallback({ eventId: event.id, action: "targets", filter, settings })
    }
  ]);

  await callTelegram(settings, "sendMessage", {
    chat_id: chatId,
    text: [`${targetFilterLabel(filter)}ล่าสุด`, ...lines, "", "กดปุ่มเพื่อดูรายชื่อในงาน"].join("\n"),
    reply_markup: { inline_keyboard: inlineKeyboard }
  });
}

async function sendEventsList(chatId: string, settings: SettingsMap) {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("events")
    .select("id,name,slug,is_open,archived_at,expected_total")
    .order("created_at", { ascending: false })
    .limit(12);
  if (error) throw error;
  const lines = (data ?? []).map((event) => {
    const state = event.archived_at ? "ปิด/ล้างแล้ว" : event.is_open ? "เปิดอยู่" : "ปิดรับ";
    return `• ${event.name} - ${state} - ${Number(event.expected_total ?? 0).toLocaleString("th-TH")} บาท`;
  });

  const inlineKeyboard = (data ?? []).map((event) => [
    {
      text: "รายชื่อ",
      callback_data: signEventMenuCallback({ eventId: event.id, action: "targets", filter: "all", settings })
    },
    {
      text: "สลิป",
      callback_data: signEventMenuCallback({ eventId: event.id, action: "slips", settings })
    },
    {
      text: "ค้างจ่าย",
      callback_data: signEventMenuCallback({ eventId: event.id, action: "unpaid", filter: "unpaid", settings })
    },
    {
      text: "เว็บ",
      url: appBaseUrl()
    }
  ]);

  await callTelegram(settings, "sendMessage", {
    chat_id: chatId,
    text: lines.length
      ? ["งานทั้งหมด", ...lines, "", "กดปุ่มใต้ข้อความนี้เพื่อดูรายชื่อหรือสลิปของงาน"].join("\n")
      : "ยังไม่มีงาน",
    reply_markup: inlineKeyboard.length ? { inline_keyboard: inlineKeyboard } : mainKeyboard()
  });
}

async function sendTargetsList(chatId: string, settings: SettingsMap, query: string) {
  const supabase = createServiceClient();
  if (!query) {
    await sendEventsList(chatId, settings);
    return;
  }

  const { data: events, error: eventError } = await supabase
    .from("events")
    .select("id,name,slug")
    .order("created_at", { ascending: false })
    .limit(100);
  if (eventError) throw eventError;
  const normalizedQuery = query.trim().toLowerCase();
  const event = (events ?? []).find(
    (item) =>
      item.slug.toLowerCase() === normalizedQuery ||
      item.id === query ||
      item.name.toLowerCase().includes(normalizedQuery)
  );
  if (!event) {
    await callTelegram(settings, "sendMessage", messageWithMainKeyboard({
      chat_id: chatId,
      text: "ไม่พบงานที่ค้นหา กดปุ่มงานทั้งหมดเพื่อเลือกจากรายการ"
    }));
    return;
  }

  await sendTargetsListByEvent(chatId, settings, event.id, "all", 0);
}

async function sendTargetsListByEvent(
  chatId: string,
  settings: SettingsMap,
  eventId: string,
  filter: TargetFilter,
  page: number
) {
  const supabase = createServiceClient();
  const { data: event, error: eventError } = await supabase
    .from("events")
    .select("id,name")
    .eq("id", eventId)
    .maybeSingle();
  if (eventError) throw eventError;
  if (!event) {
    await callTelegram(settings, "sendMessage", messageWithMainKeyboard({
      chat_id: chatId,
      text: "ไม่พบงานที่เลือก"
    }));
    return;
  }

  if (filter === "unpaid") {
    const { data: unpaidTargets, error: unpaidError, count } = await supabase
      .from("payment_targets")
      .select("display_name,amount_due", { count: "exact" })
      .eq("event_id", eventId)
      .neq("status", "verified")
      .neq("status", "deleted")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (unpaidError) throw unpaidError;

    const totalUnpaid = count ?? unpaidTargets?.length ?? 0;
    if (!unpaidTargets?.length) {
      await callTelegram(settings, "sendMessage", {
        chat_id: chatId,
        text: [`${event.name}`, "ค้างจ่าย 0 คน", "ทุกคนชำระครบแล้ว"].join("\n"),
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "ดูทั้งหมด",
                callback_data: signEventMenuCallback({ eventId, action: "targets", filter: "all", settings })
              },
              {
                text: "เปิดในเว็บ",
                url: appBaseUrl()
              }
            ]
          ]
        }
      });
      return;
    }

    const lines = [
      `${event.name}`,
      `ค้างจ่าย ${totalUnpaid.toLocaleString("th-TH")} คน`,
      "",
      ...unpaidTargets.map((target, index) =>
        `${index + 1}. ${target.display_name} ${Number(target.amount_due ?? 0).toLocaleString("th-TH")} บาท`
      )
    ];
    const chunks = splitTelegramText(lines);
    for (let index = 0; index < chunks.length; index += 1) {
      await callTelegram(settings, "sendMessage", {
        chat_id: chatId,
        text: chunks[index],
        reply_markup: index === chunks.length - 1
          ? {
              inline_keyboard: [
                [
                  {
                    text: "ดูทั้งหมด",
                    callback_data: signEventMenuCallback({ eventId, action: "targets", filter: "all", settings })
                  },
                  {
                    text: "จ่ายแล้ว",
                    callback_data: signEventMenuCallback({ eventId, action: "targets", filter: "paid", settings })
                  }
                ],
                [
                  {
                    text: "เปิดในเว็บ",
                    url: appBaseUrl()
                  }
                ]
              ]
            }
          : undefined
      });
    }
    return;
  }

  const from = page * targetPageSize;
  const to = from + targetPageSize - 1;
  let targetsQuery = supabase
    .from("payment_targets")
    .select("display_name,amount_due,status", { count: "exact" })
    .eq("event_id", eventId)
    .neq("status", "deleted");

  if (filter === "paid") {
    targetsQuery = targetsQuery.eq("status", "verified");
  }

  const { data: targets, error, count } = await targetsQuery
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true })
    .range(from, to);
  if (error) throw error;

  const lines = (targets ?? []).map((target, index) => {
    const order = from + index + 1;
    const amount = Number(target.amount_due ?? 0).toLocaleString("th-TH");
    const status = filter === "paid" ? "" : ` - ${target.status}`;
    return `${order}. ${target.display_name} - ${amount} บาท${status}`;
  });

  const pageButtons = [];
  if (page > 0) {
    pageButtons.push({
      text: "ก่อนหน้า",
      callback_data: signEventPageCallback({ eventId, type: "targets", filter, page: page - 1, settings })
    });
  }
  if ((count ?? 0) > to + 1) {
    pageButtons.push({
      text: "ถัดไป",
      callback_data: signEventPageCallback({ eventId, type: "targets", filter, page: page + 1, settings })
    });
  }

  const inlineKeyboard = [
    [
      {
        text: "ทั้งหมด",
        callback_data: signEventMenuCallback({ eventId, action: "targets", filter: "all", settings })
      },
      {
        text: "ค้างจ่าย",
        callback_data: signEventMenuCallback({ eventId, action: "targets", filter: "unpaid", settings })
      },
      {
        text: "จ่ายแล้ว",
        callback_data: signEventMenuCallback({ eventId, action: "targets", filter: "paid", settings })
      }
    ],
    [
      {
        text: "ดูสลิปงานนี้",
        callback_data: signEventMenuCallback({ eventId, action: "slips", settings })
      },
      {
        text: "เปิดในเว็บ",
        url: appBaseUrl()
      }
    ],
    ...(pageButtons.length ? [pageButtons] : [])
  ];

  await callTelegram(settings, "sendMessage", {
    chat_id: chatId,
    text: lines.length
      ? [`รายชื่อ: ${event.name}`, `ตัวกรอง: ${targetFilterLabel(filter)} · หน้า ${page + 1}`, ...lines].join("\n")
      : "ยังไม่มีรายชื่อในงานนี้",
    reply_markup: { inline_keyboard: inlineKeyboard }
  });
}

async function sendSlipsList(
  chatId: string,
  settings: SettingsMap,
  mode: "pending" | "latest" | "event",
  eventId?: string
) {
  const supabase = createServiceClient();
  let query = supabase
    .from("slip_submissions")
    .select("*,payment_targets(display_name,amount_due,events(name))")
    .is("metadata_deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(5);
  if (mode === "pending") query = query.eq("status", "manual_review").is("replaced_by_slip_id", null);
  if (mode === "event" && eventId) query = query.eq("event_id", eventId);

  const { data, error } = await query;
  if (error) throw error;
  if (!data?.length) {
    await callTelegram(settings, "sendMessage", messageWithMainKeyboard({
      chat_id: chatId,
      text: mode === "pending" ? "ไม่มีสลิปรอตรวจ" : "ยังไม่มีสลิป"
    }));
    return;
  }

  for (const slip of data) {
    const target = Array.isArray(slip.payment_targets) ? slip.payment_targets[0] : slip.payment_targets;
    const eventRow = Array.isArray(target?.events) ? target?.events[0] : target?.events;
    const caption = [
      `สลิป: ${slip.status}`,
      `งาน: ${eventRow?.name ?? "-"}`,
      `ชื่อ: ${target?.display_name ?? "-"}`,
      `ยอด: ${Number(target?.amount_due ?? slip.amount_expected ?? 0).toLocaleString("th-TH")} บาท`,
      `เวลา: ${formatThaiDateTime(slip.created_at)}`
    ].join("\n");

    let imageUrl: string | null = null;
    if (slip.storage_path) {
      const signed = await supabase.storage
        .from(slip.storage_bucket)
        .createSignedUrl(slip.storage_path, 10 * 60);
      imageUrl = signed.data?.signedUrl ?? null;
    }
    await sendTelegramSlipReview({
      settings,
      slipId: slip.id,
      text: caption,
      imageUrl,
      dashboardUrl: appBaseUrl(),
      chatIds: [chatId]
    });
  }
}
