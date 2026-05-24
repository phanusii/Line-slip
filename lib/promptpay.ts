/**
 * Parse EMV TLV QR payload — ดึงยอดเงิน (field 54) และ PromptPay ID ผู้รับ (field 29.01)
 * Format: แต่ละ field = ID(2) + Length(2) + Value(Length)
 *
 * ใช้ตรวจยอดและผู้รับบนสลิปโดยไม่ต้องใช้ API ภายนอก
 */
export function parseEmvQr(payload: string): {
  amount: number | null;
  promptpayId: string | null;
  currency: string | null;
} {
  function parseTlv(str: string): Record<string, string> {
    const fields: Record<string, string> = {};
    let i = 0;
    while (i + 4 <= str.length) {
      const id = str.slice(i, i + 2);
      const len = parseInt(str.slice(i + 2, i + 4), 10);
      if (!Number.isFinite(len) || len < 0 || i + 4 + len > str.length) break;
      fields[id] = str.slice(i + 4, i + 4 + len);
      i += 4 + len;
    }
    return fields;
  }

  try {
    const fields = parseTlv(payload);

    // Field 54 = amount (e.g. "500.00")
    const amountStr = fields["54"];
    const amount = amountStr ? parseFloat(amountStr) : null;

    // Field 29 = merchant account (nested TLV)
    // Field 29.01 = PromptPay proxy ID (phone / national ID / e-wallet)
    let promptpayId: string | null = null;
    if (fields["29"]) {
      const sub = parseTlv(fields["29"]);
      promptpayId = sub["01"] ?? null;
    }

    // Field 53 = currency (764 = THB)
    const currency = fields["53"] ?? null;

    return {
      amount: amount !== null && Number.isFinite(amount) && amount > 0 ? amount : null,
      promptpayId,
      currency
    };
  } catch {
    return { amount: null, promptpayId: null, currency: null };
  }
}

function field(id: string, value: string) {
  return `${id}${value.length.toString().padStart(2, "0")}${value}`;
}

function crc16Ccitt(value: string) {
  let crc = 0xffff;

  for (let index = 0; index < value.length; index += 1) {
    crc ^= value.charCodeAt(index) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }

  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function normalizePromptPayId(promptpayId: string) {
  const value = promptpayId.replace(/[\s-]/g, "");

  if (/^0[689]\d{8}$/.test(value)) {
    return `0066${value.slice(1)}`;
  }

  if (/^\d{13}$/.test(value)) {
    return value;
  }

  if (/^\d{15}$/.test(value)) {
    return value;
  }

  throw new Error("PromptPay ID ต้องเป็นเบอร์มือถือไทย, เลขบัตรประชาชน 13 หลัก หรือ e-wallet 15 หลัก");
}

export function buildPromptPayPayload(promptpayId: string, amount: number) {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("ยอดเงินสำหรับ QR Code ไม่ถูกต้อง");
  }

  const proxyId = normalizePromptPayId(promptpayId);
  const merchantAccount = field("00", "A000000677010111") + field("01", proxyId);
  const payloadWithoutCrc = [
    field("00", "01"),
    field("01", "12"),
    field("29", merchantAccount),
    field("53", "764"),
    field("54", amount.toFixed(2)),
    field("58", "TH"),
    "6304"
  ].join("");

  return `${payloadWithoutCrc}${crc16Ccitt(payloadWithoutCrc)}`;
}
