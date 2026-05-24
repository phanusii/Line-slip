import crypto from "node:crypto";
import { appBaseUrl } from "@/lib/line";
import { getSettings, SettingsMap } from "@/lib/settings";
import { applySlipStatus } from "@/lib/slip-status";
import { createServiceClient } from "@/lib/supabase/server";

type TelegramAction = "verified" | "rejected";

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

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
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

function compactName(user?: TelegramMessage["from"]) {
  return user?.username
    ? `@${user.username}`
    : [user?.first_name, user?.last_name].filter(Boolean).join(" ") || "telegram-admin";
}

function chatTitle(chat: TelegramChat) {
  return chat.title ?? chat.username ?? ([chat.first_name, chat.last_name].filter(Boolean).join(" ") || String(chat.id));
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
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("telegram_admin_chats")
    .select("*")
    .eq("enabled", true)
    .order("last_seen_at", { ascending: false });

  if (error) throw error;
  return data ?? [];
}

export async function bindTelegramChat(input: {
  chat: TelegramChat;
  adminEmail: string;
  from?: TelegramMessage["from"];
}) {
  const supabase = createServiceClient();
  const now = new Date().toISOString();
  const chatId = String(input.chat.id);
  const { error } = await supabase.from("telegram_admin_chats").upsert(
    {
      chat_id: chatId,
      chat_type: input.chat.type ?? null,
      chat_title: chatTitle(input.chat),
      admin_email: input.adminEmail,
      enabled: true,
      last_seen_at: now
    },
    { onConflict: "chat_id" }
  );
  if (error) throw error;

  await supabase.from("settings").upsert([
    { key: "telegram_chat_id", value: chatId, updated_at: now },
    { key: "admin_review_channel", value: "telegram", updated_at: now }
  ]);

  await supabase.from("audit_logs").insert({
    actor_email: input.adminEmail,
    actor_role: "admin",
    action: "telegram_chat_connected",
    entity_type: "telegram_admin_chat",
    after_data: {
      chat_id: chatId,
      chat_type: input.chat.type ?? null,
      chat_title: chatTitle(input.chat),
      telegram_user: compactName(input.from)
    },
    reason: "เชื่อม Telegram admin chat จาก bot start link"
  });
}

async function createReviewActionToken(slipId: string, action: TelegramAction, settings: SettingsMap) {
  const supabase = createServiceClient();
  const token = crypto.randomBytes(18).toString("base64url");
  const ttlHours = Number(settings.admin_review_token_ttl_hours || 24);
  const expiresAt = new Date(Date.now() + Math.max(1, ttlHours) * 60 * 60 * 1000).toISOString();
  const { error } = await supabase.from("telegram_review_actions").insert({
    slip_id: slipId,
    action,
    token_hash: hashToken(token),
    expires_at: expiresAt
  });
  if (error) throw error;
  return token;
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

  const approveToken = await createReviewActionToken(input.slipId, "verified", input.settings);
  const rejectToken = await createReviewActionToken(input.slipId, "rejected", input.settings);
  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "อนุมัติ", callback_data: `review:${approveToken}` },
        { text: "ปฏิเสธ", callback_data: `review:${rejectToken}` }
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
    await callTelegram(settings, "sendMessage", {
      chat_id: chatId,
      text: "ทดสอบ Telegram สำเร็จ: ระบบพร้อมแจ้งเตือนสลิปและตรวจจากปุ่มในแชท"
    });
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
  if (!callback.data?.startsWith("review:")) return;
  const chatId = callback.message?.chat ? String(callback.message.chat.id) : null;
  if (!chatId || !(await isTrustedChat(chatId, settings))) {
    await callTelegram(settings, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "แชทนี้ไม่มีสิทธิ์ตรวจสลิป",
      show_alert: true
    }).catch(() => null);
    return;
  }

  await callTelegram(settings, "answerCallbackQuery", {
    callback_query_id: callback.id,
    text: "กำลังบันทึกผลตรวจ..."
  }).catch(() => null);

  const token = callback.data.slice("review:".length);
  const supabase = createServiceClient();
  const { data: actionRow, error } = await supabase
    .from("telegram_review_actions")
    .select("*")
    .eq("token_hash", hashToken(token))
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (error) throw error;
  if (!actionRow) {
    await callTelegram(settings, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "ปุ่มนี้หมดอายุหรือถูกใช้งานแล้ว",
      show_alert: true
    }).catch(() => null);
    return;
  }

  const action = actionRow.action as TelegramAction;
  await applySlipStatus({
    slipId: actionRow.slip_id,
    status: action,
    reason: action === "verified" ? "อนุมัติจาก Telegram" : "ปฏิเสธจาก Telegram",
    actor: {
      actor_email: compactName(callback.from),
      actor_role: "admin"
    },
    auditAction: action === "verified" ? "telegram_review_approved" : "telegram_review_rejected",
    source: "telegram"
  });

  await supabase
    .from("telegram_review_actions")
    .update({
      used_at: new Date().toISOString(),
      used_chat_id: chatId,
      used_by: compactName(callback.from)
    })
    .eq("id", actionRow.id);

  const text = action === "verified" ? "อนุมัติสลิปแล้ว" : "ปฏิเสธสลิปแล้ว";
  await callTelegram(settings, "answerCallbackQuery", {
    callback_query_id: callback.id,
    text
  }).catch(() => null);

  if (callback.message?.chat?.id && callback.message.message_id) {
    await callTelegram(settings, "sendMessage", {
      chat_id: callback.message.chat.id,
      text: `${text} โดย ${compactName(callback.from)}`
    }).catch(() => null);
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
    await callTelegram(settings, "sendMessage", {
      chat_id: chatId,
      text: "เชื่อม Telegram สำเร็จแล้ว ต่อไปสลิปใหม่จะเด้งมาที่แชทนี้ และตรวจด้วยปุ่มอนุมัติ/ปฏิเสธได้"
    });
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
    await callTelegram(settings, "sendMessage", {
      chat_id: chatId,
      text: [
        "คำสั่ง Telegram",
        "/events ดูงานทั้งหมด",
        "/targets <รหัสงานหรือชื่องาน> ดูรายชื่อในงาน",
        "/pending ดูสลิปรอตรวจ",
        "/slips ดูสลิปล่าสุด"
      ].join("\n")
    });
    return;
  }

  if (command === "/events") {
    await sendEventsList(chatId, settings);
    return;
  }
  if (command === "/targets") {
    await sendTargetsList(chatId, settings, args.join(" "));
    return;
  }
  if (command === "/pending") {
    await sendSlipsList(chatId, settings, "pending");
    return;
  }
  if (command === "/slips") {
    await sendSlipsList(chatId, settings, "latest");
    return;
  }
}

async function isTrustedChat(chatId: string, settings: SettingsMap) {
  if (settings.telegram_chat_id === chatId) return true;
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("telegram_admin_chats")
    .select("id")
    .eq("chat_id", chatId)
    .eq("enabled", true)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

async function sendEventsList(chatId: string, settings: SettingsMap) {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("events")
    .select("id,name,slug,is_open,archived_at,expected_total")
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw error;
  const lines = (data ?? []).map((event) => {
    const state = event.archived_at ? "ปิด/ล้างแล้ว" : event.is_open ? "เปิดอยู่" : "ปิดรับ";
    return `• ${event.name} (${event.slug}) - ${state} - ${Number(event.expected_total ?? 0).toLocaleString("th-TH")} บาท`;
  });
  await callTelegram(settings, "sendMessage", {
    chat_id: chatId,
    text: lines.length ? ["งานทั้งหมด", ...lines, "", "ดูรายชื่อ: /targets <slug>"].join("\n") : "ยังไม่มีงาน"
  });
}

async function sendTargetsList(chatId: string, settings: SettingsMap, query: string) {
  const supabase = createServiceClient();
  if (!query) {
    await callTelegram(settings, "sendMessage", {
      chat_id: chatId,
      text: "พิมพ์ /events เพื่อดูรหัสงานก่อน แล้วใช้ /targets <slug>"
    });
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
    await callTelegram(settings, "sendMessage", { chat_id: chatId, text: "ไม่พบงานที่ค้นหา" });
    return;
  }

  const { data: targets, error } = await supabase
    .from("payment_targets")
    .select("display_name,amount_due,status")
    .eq("event_id", event.id)
    .neq("status", "deleted")
    .order("display_name")
    .limit(80);
  if (error) throw error;

  const lines = (targets ?? []).map(
    (target) =>
      `• ${target.display_name} - ${Number(target.amount_due ?? 0).toLocaleString("th-TH")} บาท - ${target.status}`
  );
  await callTelegram(settings, "sendMessage", {
    chat_id: chatId,
    text: lines.length ? [`รายชื่อ: ${event.name}`, ...lines].join("\n") : "ยังไม่มีรายชื่อในงานนี้"
  });
}

async function sendSlipsList(chatId: string, settings: SettingsMap, mode: "pending" | "latest") {
  const supabase = createServiceClient();
  let query = supabase
    .from("slip_submissions")
    .select("*,payment_targets(display_name,amount_due,events(name))")
    .is("metadata_deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(5);
  if (mode === "pending") query = query.eq("status", "manual_review").is("replaced_by_slip_id", null);

  const { data, error } = await query;
  if (error) throw error;
  if (!data?.length) {
    await callTelegram(settings, "sendMessage", {
      chat_id: chatId,
      text: mode === "pending" ? "ไม่มีสลิปรอตรวจ" : "ยังไม่มีสลิป"
    });
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
      `เวลา: ${new Date(slip.created_at).toLocaleString("th-TH")}`
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
