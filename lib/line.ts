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
