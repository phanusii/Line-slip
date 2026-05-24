/**
 * SlipOK API integration — Thai bank slip OCR service.
 * API docs: https://www.slipok.com/api-documentation
 *
 * SlipOK อ่านสลิปธนาคารไทย ให้ยอดเงิน, QR ref, ชื่อผู้โอน/รับ ฯลฯ
 * ใช้แทน Tesseract.js เพื่อความแม่นยำสูงกว่า
 */

type SlipOkResponse = {
  success: boolean;
  code?: number;
  message?: string;
  data?: {
    amount?: number;
    ref1?: string;
    ref2?: string;
    ref3?: string;
    sendingBank?: string;
    receivingBank?: string;
    transDate?: string;
    transTime?: string;
    transRef?: string;
    toAccountName?: {
      th?: string;
      en?: string;
    };
    fromAccountName?: {
      th?: string;
      en?: string;
    };
    qrCode?: string;
  };
};

export type SlipOkOcrResult = {
  enabled: boolean;
  available: boolean;
  source: "slipok";
  confidence: number | null;
  minConfidence?: number;
  amountMatched: boolean | null;
  amounts: number[];
  selectedAmount: number | null;
  text?: string;
  error?: string;
  rawData?: SlipOkResponse["data"];
};

function toSatang(value: number) {
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

/**
 * ส่งรูปสลิปไป SlipOK API แล้วแปลผลลัพธ์ให้เป็น OcrResult format เดียวกับ Tesseract
 */
export async function runSlipOkOcr(
  imageBuffer: Buffer,
  expectedAmount: number | null | undefined,
  apiKey: string
): Promise<SlipOkOcrResult> {
  try {
    const form = new FormData();
    const blob = new Blob([new Uint8Array(imageBuffer)], { type: "image/jpeg" });
    form.append("files", blob, "slip.jpg");
    form.append("log", "true");

    const response = await fetch(`https://api.slipok.com/api/line/apikey/${encodeURIComponent(apiKey)}`, {
      method: "POST",
      body: form
    });

    const json = (await response.json().catch(() => null)) as SlipOkResponse | null;

    if (!response.ok || !json?.success) {
      const message = json?.message ?? `SlipOK API error: ${response.status}`;
      return {
        enabled: true,
        available: false,
        source: "slipok",
        confidence: null,
        amountMatched: null,
        amounts: [],
        selectedAmount: null,
        error: message
      };
    }

    const detectedAmount = typeof json.data?.amount === "number" ? json.data.amount : null;
    const amounts = detectedAmount !== null ? [detectedAmount] : [];

    const expectedSatang =
      typeof expectedAmount === "number" && Number.isFinite(expectedAmount)
        ? toSatang(expectedAmount)
        : null;
    const detectedSatang = detectedAmount !== null ? toSatang(detectedAmount) : null;
    const amountMatched =
      expectedSatang !== null && detectedSatang !== null
        ? detectedSatang === expectedSatang
        : null;

    // SlipOK ไม่มี confidence score — ถือว่า 100 เมื่อ API ส่งกลับสำเร็จ
    return {
      enabled: true,
      available: true,
      source: "slipok",
      confidence: 100,
      amountMatched,
      amounts,
      selectedAmount: detectedAmount,
      text: [json.data?.fromAccountName?.th, json.data?.toAccountName?.th]
        .filter(Boolean)
        .join(" → ") || undefined,
      rawData: json.data
    };
  } catch (error) {
    return {
      enabled: true,
      available: false,
      source: "slipok",
      confidence: null,
      amountMatched: null,
      amounts: [],
      selectedAmount: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
