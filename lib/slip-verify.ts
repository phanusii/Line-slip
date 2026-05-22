/**
 * EasySlip slip-verification wrapper (https://easyslip.app)
 *
 * Free tier: 30 verifications/month
 * Required env var: EASYSLIP_API_KEY
 *
 * Possible outcomes
 * -----------------
 * ok: true  → amount / slipRef / transferDatetime / sender / receiver extracted
 * ok: false, reason:
 *   "not_configured" → EASYSLIP_API_KEY not set  (falls back to manual_review)
 *   "invalid_slip"   → image unreadable / not a real slip
 *   "duplicate"      → EasySlip returned 410 (same transRef seen before)
 *   "api_error"      → network timeout, unexpected response, etc.
 */

export type SlipVerifyResult =
  | {
      ok: true;
      amount: number;
      slipRef: string;
      transferDatetime: string | null; // ISO-8601
      senderName: string;
      receiverName: string;
    }
  | {
      ok: false;
      reason: "not_configured" | "invalid_slip" | "duplicate" | "api_error";
      message: string;
    };

type EasySlipResponse = {
  status: number;
  message?: string;
  data?: {
    transRef: string;
    date: string;
    amount: { amount: number };
    sender: { account: { name: { th?: string; en?: string } } };
    receiver: { account: { name: { th?: string; en?: string } } };
  };
};

export async function verifySlip(
  imageBuffer: Buffer
): Promise<SlipVerifyResult> {
  const apiKey = process.env.EASYSLIP_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      reason: "not_configured",
      message: "ไม่ได้ตั้งค่า EASYSLIP_API_KEY — ส่งแอดมินตรวจสอบแทน"
    };
  }

  try {
    const form = new FormData();
    // Copy to a guaranteed ArrayBuffer (Node Buffer.buffer may be SharedArrayBuffer)
    const ab = imageBuffer.buffer.slice(
      imageBuffer.byteOffset,
      imageBuffer.byteOffset + imageBuffer.byteLength
    ) as ArrayBuffer;
    form.append("file", new Blob([ab], { type: "image/jpeg" }), "slip.jpg");

    const res = await fetch("https://developer.easyslip.app/api/v1/verify", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(15_000) // 15 s
    });

    const json = (await res.json()) as EasySlipResponse;

    // 410 = duplicate transaction reference
    if (res.status === 410 || json.status === 410) {
      return {
        ok: false,
        reason: "duplicate",
        message: "สลิปนี้เคยถูกส่งตรวจแล้ว"
      };
    }

    if (json.status !== 200 || !json.data) {
      return {
        ok: false,
        reason: "invalid_slip",
        message: json.message ?? "อ่านข้อมูลจากสลิปไม่ได้"
      };
    }

    const d = json.data;
    let transferDatetime: string | null = null;
    try {
      transferDatetime = new Date(d.date).toISOString();
    } catch {
      // leave null
    }

    return {
      ok: true,
      amount: d.amount.amount,
      slipRef: d.transRef,
      transferDatetime,
      senderName:
        d.sender.account.name.th ?? d.sender.account.name.en ?? "ไม่ทราบ",
      receiverName:
        d.receiver.account.name.th ??
        d.receiver.account.name.en ??
        "ไม่ทราบ"
    };
  } catch (err) {
    return {
      ok: false,
      reason: "api_error",
      message: err instanceof Error ? err.message : "เรียก EasySlip API ไม่สำเร็จ"
    };
  }
}
