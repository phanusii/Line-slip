import sharp from "sharp";
import { getBooleanSetting, getNumberSetting, getSettings } from "@/lib/settings";
import { createServiceClient } from "@/lib/supabase/server";

type EvaluateInput = {
  slipId: string;
  eventId: string;
  paymentTargetId?: string | null;
  lineUserDbId?: string | null;
  slipRef?: string | null;
  normalizedBuffer: Buffer;
  amountExpected?: number | null;
  /** ยอดเงินที่ parse ได้จาก QR code บนสลิป (field 54 EMV) */
  qrAmount?: number | null;
  /** PromptPay proxy ID ที่ parse ได้จาก QR code บนสลิป (field 29.01 EMV) */
  qrProxyId?: string | null;
};

type OcrResult = {
  enabled: boolean;
  available: boolean;
  confidence: number | null;
  minConfidence?: number;
  amountMatched: boolean | null;
  amounts?: number[];
  selectedAmount?: number | null;
  text?: string;
  error?: string;
};

export type FreeAutoSlipCheckResult = {
  shouldVerify: boolean;
  status: "passed" | "manual_review" | "disabled";
  reasons: string[];
  ocrResult?: OcrResult;
  amountDetected?: number | null;
};

function toSatang(value: number) {
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

function parseAmounts(text: string) {
  return Array.from(text.matchAll(/(?<![\d.,])\d{1,3}(?:,\d{3})*\.\d{2}(?![\d.,])|(?<![\d.,])\d+\.\d{2}(?![\d.,])/g))
    .map((match) => Number(match[0].replace(/,/g, "")))
    .filter(Number.isFinite);
}

function clippedText(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 700);
}

/**
 * Normalize PromptPay proxy ID เพื่อเปรียบเทียบ
 * 0812345678, 66812345678, 0066812345678 → "812345678"
 */
function normalizeProxyId(id: string) {
  return id.replace(/\D/g, "").replace(/^(0066|66|0)/, "");
}

/**
 * Preprocess รูปสลิปก่อนส่งไป Tesseract OCR
 * - greyscale: ลด noise สี
 * - normalize: auto-contrast (ช่วยสลิปมืดหรือสว่างเกิน)
 * - sharpen: เพิ่มความคมชัดตัวเลข
 */
async function preprocessForOcr(buffer: Buffer): Promise<Buffer> {
  try {
    return await sharp(buffer, { failOn: "none" })
      .greyscale()
      .normalize()
      .sharpen()
      .jpeg({ quality: 95 })
      .toBuffer();
  } catch {
    return buffer; // ถ้า preprocess ไม่ได้ ใช้ buffer เดิม
  }
}

async function runFreeOcr(
  buffer: Buffer,
  expectedAmount?: number | null,
  minConfidence = 45
): Promise<OcrResult> {
  try {
    const [tesseract, processedBuffer] = await Promise.all([
      import("tesseract.js"),
      preprocessForOcr(buffer)
    ]);
    // PSM 11 = sparse text — เหมาะกับสลิปที่ข้อความกระจัดกระจาย
    const result = await tesseract.recognize(processedBuffer, "eng", {
      psm: 11
    } as Parameters<typeof tesseract.recognize>[2]);
    const text = result.data.text ?? "";
    const confidence = Number(result.data.confidence ?? 0);
    const amounts = parseAmounts(text);
    const expectedSatang =
      typeof expectedAmount === "number" && Number.isFinite(expectedAmount)
        ? toSatang(expectedAmount)
        : null;
    const matchedAmount =
      expectedSatang === null
        ? null
        : amounts.find((amount) => toSatang(amount) === expectedSatang) ?? null;
    const selectedAmount = matchedAmount ?? amounts[0] ?? null;
    const amountMatched =
      expectedSatang !== null
        ? matchedAmount !== null
        : null;

    return {
      enabled: true,
      available: true,
      confidence,
      minConfidence,
      amountMatched,
      amounts,
      selectedAmount,
      text: clippedText(text)
    };
  } catch (error) {
    return {
      enabled: true,
      available: false,
      confidence: null,
      minConfidence,
      amountMatched: null,
      amounts: [],
      selectedAmount: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function evaluateFreeAutoSlipCheck(input: EvaluateInput): Promise<FreeAutoSlipCheckResult> {
  const supabase = createServiceClient();
  const settings = await getSettings([
    "auto_verify_from_slip_enabled",
    "auto_verify_window_hours",
    "auto_verify_requires_unique_amount",
    "auto_verify_ocr_enabled",
    "auto_verify_ocr_min_confidence"
  ]);
  const enabled = getBooleanSetting(settings, "auto_verify_from_slip_enabled", false);
  const windowHours = getNumberSetting(settings, "auto_verify_window_hours", 24);
  const requiresUniqueAmount = getBooleanSetting(settings, "auto_verify_requires_unique_amount", true);
  const ocrEnabled = getBooleanSetting(settings, "auto_verify_ocr_enabled", false);
  const ocrMinConfidence = getNumberSetting(settings, "auto_verify_ocr_min_confidence", 45);

  // blockingReasons = ปัญหาเชิงโครงสร้าง (user/target/window/QR) → block auto-verify เสมอ
  // ocrReasons = ปัญหา OCR → block ก็ต่อเมื่อ OCR เปิดอยู่เท่านั้น
  const blockingReasons: string[] = [];
  const ocrReasons: string[] = [];
  let ocrResult: OcrResult | undefined;

  if (!enabled) {
    return {
      shouldVerify: false,
      status: "disabled",
      reasons: ["auto_verify_disabled"]
    };
  }

  if (!input.paymentTargetId) blockingReasons.push("missing_payment_target");
  if (!input.slipRef) blockingReasons.push("missing_slip_qr");
  if (!input.lineUserDbId) blockingReasons.push("missing_line_user");

  if (!input.paymentTargetId) {
    return { shouldVerify: false, status: "manual_review", reasons: blockingReasons };
  }

  // ดึง payment_target + event.promptpay_id พร้อมกัน
  const [targetResult, eventResult] = await Promise.all([
    supabase
      .from("payment_targets")
      .select("id,event_id,amount_due,status,selected_line_user_id,updated_at")
      .eq("id", input.paymentTargetId)
      .maybeSingle(),
    supabase
      .from("events")
      .select("promptpay_id")
      .eq("id", input.eventId)
      .maybeSingle()
  ]);

  if (targetResult.error) throw targetResult.error;
  if (eventResult.error) throw eventResult.error;

  const target = targetResult.data;
  const eventPromptPayId = eventResult.data?.promptpay_id ?? null;

  if (!target) {
    blockingReasons.push("target_not_found");
  } else {
    if (target.status === "verified" || target.status === "deleted") {
      blockingReasons.push(`target_status_${target.status}`);
    }
    if (!target.selected_line_user_id) {
      blockingReasons.push("target_not_selected_in_liff");
    }
    if (input.lineUserDbId && target.selected_line_user_id !== input.lineUserDbId) {
      blockingReasons.push("line_user_mismatch");
    }

    const selectedAt = new Date(String(target.updated_at)).getTime();
    const ageMs = Date.now() - selectedAt;
    if (!Number.isFinite(selectedAt) || ageMs > windowHours * 60 * 60 * 1000) {
      blockingReasons.push("selection_window_expired");
    }

    if (requiresUniqueAmount) {
      const { count, error: countError } = await supabase
        .from("payment_targets")
        .select("id", { count: "exact", head: true })
        .eq("event_id", target.event_id)
        .eq("amount_due", target.amount_due)
        .neq("status", "deleted");

      if (countError) throw countError;
      if ((count ?? 0) !== 1) {
        blockingReasons.push("amount_not_unique_in_event");
      }
    }
  }

  // === QR verification — ฟรี แม่นยำกว่า OCR ===
  // ถ้า QR มียอด → ตรวจยอดทันที
  if (input.qrAmount !== null && input.qrAmount !== undefined) {
    const qrSatang = toSatang(input.qrAmount);
    const expectedSatang =
      typeof input.amountExpected === "number" && Number.isFinite(input.amountExpected)
        ? toSatang(input.amountExpected)
        : null;
    if (expectedSatang !== null && qrSatang !== null && qrSatang !== expectedSatang) {
      blockingReasons.push("qr_amount_mismatch");
    }
  }

  // ถ้า QR มี PromptPay ID → ตรวจว่าตรงกับ PromptPay ของงาน
  if (input.qrProxyId && eventPromptPayId) {
    const normalizedQr = normalizeProxyId(input.qrProxyId);
    const normalizedEvent = normalizeProxyId(eventPromptPayId);
    if (normalizedQr && normalizedEvent && normalizedQr !== normalizedEvent) {
      blockingReasons.push("qr_recipient_mismatch");
    }
  }

  // OCR check — เป็น "soft check" บล็อกก็ต่อเมื่อ ocrEnabled เท่านั้น
  // ถ้า OCR ปิดอยู่ → ระบบยังตรวจอัตโนมัติจาก QR+user+window+uniqueness ได้
  if (ocrEnabled) {
    ocrResult = await runFreeOcr(input.normalizedBuffer, input.amountExpected, ocrMinConfidence);

    if (!ocrResult.available) {
      ocrReasons.push("ocr_unavailable");
    } else if ((ocrResult.confidence ?? 0) < ocrMinConfidence) {
      ocrReasons.push("ocr_low_confidence");
    } else if (!ocrResult.amounts?.length) {
      ocrReasons.push("ocr_amount_missing");
    } else if (ocrResult.amountMatched === false) {
      ocrReasons.push("ocr_amount_mismatch");
    }
  }

  const allReasons = [...blockingReasons, ...ocrReasons];

  if (allReasons.length) {
    return {
      shouldVerify: false,
      status: "manual_review",
      reasons: allReasons,
      ocrResult,
      amountDetected: ocrResult?.selectedAmount ?? input.qrAmount ?? null
    };
  }

  return {
    shouldVerify: true,
    status: "passed",
    reasons: ["free_auto_review_passed"],
    ocrResult,
    amountDetected: ocrResult?.selectedAmount ?? input.qrAmount ?? null
  };
}
