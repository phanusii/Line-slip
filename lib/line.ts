import crypto from "node:crypto";

export type LiffPage = "pay" | "slip" | "me";

export function appBaseUrl() {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  if (process.env.NODE_ENV === "development") return "http://localhost:3000";
  throw new Error("ยังไม่ได้ตั้งค่า NEXT_PUBLIC_APP_URL กรุณาเพิ่มตัวแปรนี้ใน environment");
}

export function liffUri(page?: LiffPage) {
  const liffId = process.env.NEXT_PUBLIC_LIFF_ID;
  const suffix = page ? `?page=${page}` : "";

  if (liffId) {
    return `https://liff.line.me/${liffId}${suffix}`;
  }

  return `${appBaseUrl()}/liff${suffix}`;
}

export function lineMenuMessages(text: string) {
  return [
    { type: "text", text },
    {
      type: "template",
      altText: "เลือกงานชำระเงินหรือดูข้อมูลของฉัน",
      template: {
        type: "buttons",
        title: "ระบบเช็กสลิป",
        text: "เลือกงานเพื่อรับ QR Code หรือดูสถานะการชำระเงินของคุณ",
        actions: [
          {
            type: "uri",
            label: "สร้าง QR",
            uri: liffUri("pay")
          },
          {
            type: "uri",
            label: "ส่งสลิป",
            uri: liffUri("slip")
          },
          {
            type: "uri",
            label: "สถานะ",
            uri: liffUri("me")
          }
        ]
      }
    }
  ];
}

export function verifyLineSignature(body: string, signature: string | null) {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret || !signature) return false;

  const digest = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("base64");

  const expected = Buffer.from(digest);
  const actual = Buffer.from(signature);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export async function replyLine(replyToken: string, messages: unknown[]) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return;

  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ replyToken, messages })
  });
}

export async function pushLine(lineUserId: string, messages: unknown[]) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return { ok: false, error: "LINE_CHANNEL_ACCESS_TOKEN is not configured" };

  const response = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ to: lineUserId, messages })
  });

  if (!response.ok) {
    return { ok: false, error: await response.text() };
  }

  return { ok: true };
}

export async function getLineMessageQuota() {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error("ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN");

  const headers = { authorization: `Bearer ${token}` };
  const [quotaResponse, consumptionResponse] = await Promise.all([
    fetch("https://api.line.me/v2/bot/message/quota", { headers }),
    fetch("https://api.line.me/v2/bot/message/quota/consumption", { headers })
  ]);

  if (!quotaResponse.ok) throw new Error(await quotaResponse.text());
  if (!consumptionResponse.ok) throw new Error(await consumptionResponse.text());

  const quota = (await quotaResponse.json()) as { type: "none" | "limited"; value?: number };
  const consumption = (await consumptionResponse.json()) as { totalUsage: number };
  const limit = quota.type === "limited" ? Number(quota.value ?? 0) : null;
  const used = Number(consumption.totalUsage ?? 0);
  const remaining = limit === null ? null : Math.max(0, limit - used);

  return {
    type: quota.type,
    limit,
    used,
    remaining,
    canPush: quota.type === "none" || (typeof remaining === "number" && remaining > 0)
  };
}

export function buildVerifiedStatusFlex(opts: {
  displayName: string;
  eventName: string;
  amountDue: number;
  paidAt: string | null;
}) {
  const dateStr = opts.paidAt
    ? new Date(opts.paidAt).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" })
    : null;

  return {
    type: "flex",
    altText: `✅ ชำระเงินแล้ว — ${opts.displayName}`,
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#16a34a",
        paddingAll: "20px",
        contents: [
          { type: "text", text: "✅ ชำระเงินแล้ว", color: "#ffffff", weight: "bold", size: "xl" }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          { type: "text", text: opts.displayName, weight: "bold", size: "lg" },
          { type: "text", text: opts.eventName, color: "#888888", size: "sm" },
          { type: "separator", margin: "md" },
          {
            type: "box", layout: "horizontal", margin: "md",
            contents: [
              { type: "text", text: "ยอดเงิน", flex: 1, color: "#555555", size: "sm" },
              { type: "text", text: `${Number(opts.amountDue).toLocaleString("th-TH")} บาท`, flex: 1, align: "end", weight: "bold", size: "sm" }
            ]
          },
          ...(dateStr ? [{
            type: "box", layout: "horizontal",
            contents: [
              { type: "text", text: "วันที่", flex: 1, color: "#555555", size: "sm" },
              { type: "text", text: dateStr, flex: 1, align: "end", size: "sm" }
            ]
          }] : [])
        ]
      }
    }
  };
}

export function buildCheckStatusFlex(liffMeUrl: string) {
  return {
    type: "flex",
    altText: "ดูสถานะการชำระเงิน",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "📋 ตรวจสอบสถานะ", weight: "bold", size: "lg" },
          { type: "text", text: "กดปุ่มด้านล่างเพื่อเลือกชื่อและดูสถานะการชำระเงิน", color: "#888888", size: "sm", wrap: true }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "button",
            style: "primary",
            color: "#2563eb",
            action: { type: "uri", label: "ดูสถานะของฉัน", uri: liffMeUrl }
          }
        ]
      }
    }
  };
}
