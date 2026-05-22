import crypto from "node:crypto";

function appBaseUrl() {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "https://line-google-line-line-line-line.vercel.app";
}

export function liffUri(page?: "me") {
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
            label: "เลือกงาน/รับ QR",
            uri: liffUri()
          },
          {
            type: "uri",
            label: "ข้อมูลของฉัน",
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

  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
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
  if (!token) return;

  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ to: lineUserId, messages })
  });
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

export function buildAutoVerifiedFlex(opts: {
  displayName: string;
  eventName: string;
  amount: number;
  senderName: string;
}) {
  return {
    type: "flex",
    altText: `✅ ยืนยันการชำระเงิน ${opts.amount.toLocaleString("th-TH")} บาท`,
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#16a34a",
        paddingAll: "20px",
        contents: [
          { type: "text", text: "✅ ยืนยันการชำระเงินสำเร็จ", color: "#ffffff", weight: "bold", size: "lg" }
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
              { type: "text", text: "ยอดที่ชำระ", flex: 1, color: "#555555", size: "sm" },
              { type: "text", text: `${opts.amount.toLocaleString("th-TH")} บาท`, flex: 1, align: "end", weight: "bold", color: "#16a34a", size: "sm" }
            ]
          },
          {
            type: "box", layout: "horizontal",
            contents: [
              { type: "text", text: "ผู้โอน", flex: 1, color: "#555555", size: "sm" },
              { type: "text", text: opts.senderName, flex: 2, align: "end", size: "sm", wrap: true }
            ]
          }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "ระบบตรวจสอบอัตโนมัติผ่าน EasySlip", size: "xs", color: "#aaaaaa", align: "center" }
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
