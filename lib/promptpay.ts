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
