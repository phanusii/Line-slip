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
            type: "postback",
            label: "สถานะ",
            data: "action=check_status",
            displayText: "ดูสถานะ"
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

const lineStatusText: Record<string, string> = {
  unpaid: "ยังไม่จ่าย",
  pending_slip: "รอส่งสลิป",
  verified: "สลิปผ่าน / จ่ายแล้ว",
  manual_review: "รอตรวจ",
  amount_mismatch: "ยอดไม่ตรง",
  duplicate_slip: "สลิปซ้ำ",
  rejected: "ไม่ผ่าน"
};

function statusColor(status: string) {
  if (status === "verified") return "#16a34a";
  if (status === "manual_review") return "#2563eb";
  if (status === "rejected" || status === "amount_mismatch" || status === "duplicate_slip") {
    return "#dc2626";
  }
  return "#f59e0b";
}

export function buildPaymentStatusFlex(opts: {
  displayName: string;
  eventName: string;
  amountDue: number;
  status: string;
  paidAt?: string | null;
  latestSlipAt?: string | null;
  liffPayUrl: string;
  liffSlipUrl: string;
}) {
  const statusLabel = lineStatusText[opts.status] ?? opts.status;
  const color = statusColor(opts.status);
  const dateSource = opts.status === "verified" ? opts.paidAt : opts.latestSlipAt;
  const dateStr = dateSource
    ? new Date(dateSource).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" })
    : null;
  const shouldUpload = ["unpaid", "pending_slip", "rejected", "amount_mismatch"].includes(opts.status);
  const actionUrl = opts.status === "unpaid" ? opts.liffPayUrl : opts.liffSlipUrl;
  const actionLabel = opts.status === "unpaid" ? "สร้าง QR / ส่งสลิป" : "ส่งสลิปใหม่";

  return {
    type: "bubble",
    header: {
      type: "box",
      layout: "vertical",
      backgroundColor: color,
      paddingAll: "16px",
      contents: [{ type: "text", text: statusLabel, color: "#ffffff", weight: "bold", size: "lg" }]
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        { type: "text", text: opts.displayName, weight: "bold", size: "lg", wrap: true },
        { type: "text", text: opts.eventName, color: "#64748b", size: "sm", wrap: true },
        { type: "separator", margin: "md" },
        {
          type: "box",
          layout: "horizontal",
          margin: "md",
          contents: [
            { type: "text", text: "ยอดเงิน", flex: 1, color: "#64748b", size: "sm" },
            {
              type: "text",
              text: `${Number(opts.amountDue).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บาท`,
              flex: 1,
              align: "end",
              weight: "bold",
              size: "sm"
            }
          ]
        },
        ...(dateStr
          ? [
              {
                type: "box",
                layout: "horizontal",
                contents: [
                  { type: "text", text: opts.status === "verified" ? "อนุมัติเมื่อ" : "ส่งสลิปเมื่อ", flex: 1, color: "#64748b", size: "sm" },
                  { type: "text", text: dateStr, flex: 1, align: "end", size: "sm", wrap: true }
                ]
              }
            ]
          : []),
        ...(opts.status === "manual_review"
          ? [{ type: "text", text: "ระบบได้รับสลิปแล้ว กรุณารอผู้ดูแลตรวจสอบ", color: "#64748b", size: "xs", wrap: true, margin: "md" }]
          : [])
      ]
    },
    ...(shouldUpload
      ? {
          footer: {
            type: "box",
            layout: "vertical",
            contents: [
              {
                type: "button",
                style: "primary",
                color,
                action: { type: "uri", label: actionLabel, uri: actionUrl }
              }
            ]
          }
        }
      : {})
  };
}

export function buildStatusFlexMessage(bubbles: unknown[]) {
  return {
    type: "flex",
    altText: "สถานะการชำระเงินล่าสุด",
    contents:
      bubbles.length === 1
        ? bubbles[0]
        : {
            type: "carousel",
            contents: bubbles.slice(0, 10)
          }
  };
}

export function buildNoPaymentStatusFlex(liffPayUrl: string) {
  return buildStatusFlexMessage([
    {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "ยังไม่มีรายการชำระเงิน", weight: "bold", size: "lg", wrap: true },
          { type: "text", text: "กรุณากดสร้าง QR และเลือกรายชื่อก่อน ระบบจึงจะแสดงสถานะให้ได้", color: "#64748b", size: "sm", wrap: true }
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
            action: { type: "uri", label: "สร้าง QR Code", uri: liffPayUrl }
          }
        ]
      }
    }
  ]);
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
