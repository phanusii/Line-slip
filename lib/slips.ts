import crypto from "node:crypto";
import jsQR from "jsqr";
import sharp from "sharp";
import { notifyAdminSlipReview } from "@/lib/admin-review";
import { STORAGE_BUCKET } from "@/lib/env";
import { evaluateFreeAutoSlipCheck } from "@/lib/free-auto-slip";
import { parseEmvQr } from "@/lib/promptpay";
import { applySlipStatus } from "@/lib/slip-status";
import { createServiceClient } from "@/lib/supabase/server";

type UploadSlipInput = {
  eventId: string;
  eventSlug: string;
  paymentTargetId?: string | null;
  personName?: string | null;
  amountExpected?: number | null;
  sourceBuffer: Buffer;
  mimeType?: string | null;
  lineMessageId?: string | null;
  lineUserDbId?: string | null;
  autoReviewMode?: "sync" | "deferred";
};

export type UploadSlipResult = {
  id?: string;
  status: "manual_review" | "duplicate_blocked" | "verified";
  autoCheckStatus?: string | null;
  autoCheckReasons?: string[];
  duplicateOfId?: string;
};

type AutoReviewResult = {
  shouldVerify: boolean;
  status: "verified" | "manual_review";
  autoCheckStatus: string;
  autoCheckReasons: string[];
};

export async function normalizeSlipImage(source: Buffer) {
  return sharp(source, { failOn: "none" })
    .rotate()
    .resize({ width: 1600, withoutEnlargement: true })
    .jpeg({ quality: 78, mozjpeg: true })
    .toBuffer();
}

export function hashImage(buffer: Buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function isMissingColumnError(error: unknown, column: string) {
  const message = error instanceof Error ? error.message : JSON.stringify(error);
  return message.includes(column) && message.includes("schema cache");
}

function isDuplicateSlipConstraintError(error: unknown) {
  const supabaseError = error as { code?: string; message?: string; details?: string };
  const text = `${supabaseError.message ?? ""} ${supabaseError.details ?? ""}`;
  return (
    supabaseError.code === "23505" &&
    text.includes("slip_submissions") &&
    (text.includes("slip_ref") || text.includes("image_hash"))
  );
}

async function auditDuplicateSlipAttempt(
  supabase: ReturnType<typeof createServiceClient>,
  input: UploadSlipInput,
  duplicate: { id: string; event_id?: string | null; payment_target_id?: string | null },
  reason: "duplicate_slip_qr" | "duplicate_image_hash",
  details: { imageHash: string; slipRef: string | null }
) {
  const audit = await supabase.from("audit_logs").insert({
    actor_email: "system-duplicate-blocker",
    actor_role: "viewer",
    action: "duplicate_slip_blocked",
    entity_type: "slip_submission",
    entity_id: duplicate.id,
    event_id: input.eventId,
    after_data: {
      duplicate_of_id: duplicate.id,
      duplicate_by: reason === "duplicate_slip_qr" ? "slip_ref" : "image_hash",
      duplicate_event_id: duplicate.event_id ?? null,
      duplicate_payment_target_id: duplicate.payment_target_id ?? null,
      attempted_payment_target_id: input.paymentTargetId ?? null,
      line_user_id: input.lineUserDbId ?? null,
      line_message_id: input.lineMessageId ?? null,
      image_hash: details.imageHash,
      slip_ref: details.slipRef
    },
    reason: "Blocked duplicate slip before storage upload and database insert"
  });

  if (audit.error) {
    console.error("duplicate slip audit failed", audit.error);
  }
}

async function findDuplicateSlip(
  supabase: ReturnType<typeof createServiceClient>,
  imageHash: string,
  slipRef: string | null
) {
  if (slipRef) {
    const qrDuplicate = await supabase
      .from("slip_submissions")
      .select("id,event_id,payment_target_id")
      .eq("slip_ref", slipRef)
      .is("metadata_deleted_at", null)
      .limit(1)
      .maybeSingle();

    if (qrDuplicate.error) {
      throw qrDuplicate.error;
    }

    if (qrDuplicate.data) {
      return {
        duplicate: qrDuplicate.data,
        reason: "duplicate_slip_qr" as const
      };
    }
  }

  const imageDuplicate = await supabase
    .from("slip_submissions")
    .select("id,event_id,payment_target_id")
    .eq("image_hash", imageHash)
    .is("metadata_deleted_at", null)
    .limit(1)
    .maybeSingle();

  if (imageDuplicate.error) {
    throw imageDuplicate.error;
  }

  if (imageDuplicate.data) {
    return {
      duplicate: imageDuplicate.data,
      reason: "duplicate_image_hash" as const
    };
  }

  return null;
}

export async function readSlipQrRef(buffer: Buffer) {
  const data = await readSlipQrPayload(buffer);
  if (!data) return null;
  return `qr:${crypto.createHash("sha256").update(data).digest("hex")}`;
}

export async function readSlipQrPayload(buffer: Buffer) {
  const image = await sharp(buffer, { failOn: "none" })
    .rotate()
    .resize({ width: 1400, withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const decoded = jsQR(
    new Uint8ClampedArray(image.data),
    image.info.width,
    image.info.height,
    { inversionAttempts: "attemptBoth" }
  );

  if (!decoded?.data) return null;
  return decoded.data;
}

async function runAutoReviewForSlip(input: {
  slipId: string;
  eventId: string;
  paymentTargetId?: string | null;
  lineUserDbId?: string | null;
  slipRef?: string | null;
  normalizedBuffer: Buffer;
  amountExpected?: number | null;
  qrAmount?: number | null;
  qrProxyId?: string | null;
}): Promise<AutoReviewResult> {
  const supabase = createServiceClient();
  const autoCheck = await evaluateFreeAutoSlipCheck({
    slipId: input.slipId,
    eventId: input.eventId,
    paymentTargetId: input.paymentTargetId ?? null,
    lineUserDbId: input.lineUserDbId ?? null,
    slipRef: input.slipRef ?? null,
    normalizedBuffer: input.normalizedBuffer,
    amountExpected: input.amountExpected ?? null,
    qrAmount: input.qrAmount ?? null,
    qrProxyId: input.qrProxyId ?? null
  });

  const autoCheckUpdated = await supabase
    .from("slip_submissions")
    .update({
      amount_detected: autoCheck.amountDetected ?? null,
      auto_check_status: autoCheck.status,
      auto_check_reasons: autoCheck.reasons,
      auto_checked_at: new Date().toISOString(),
      ocr_result: autoCheck.ocrResult ?? null
    })
    .eq("id", input.slipId);

  if (autoCheckUpdated.error) throw autoCheckUpdated.error;

  if (autoCheck.shouldVerify) {
    await applySlipStatus({
      slipId: input.slipId,
      status: "verified",
      reason:
        "ตรวจผ่านอัตโนมัติจากรูปสลิป: QR ไม่ซ้ำ รูปไม่ซ้ำ ยอดเฉพาะรายชื่อ และอยู่ในช่วงเวลาที่กำหนด ไม่ใช่การยืนยันจากธนาคาร",
      actor: {
        actor_email: "system-free-auto-review",
        actor_role: "viewer"
      },
      auditAction: "auto_verify_from_slip",
      source: "free_auto_review"
    });
  }

  return {
    shouldVerify: autoCheck.shouldVerify,
    status: autoCheck.shouldVerify ? "verified" : "manual_review",
    autoCheckStatus: autoCheck.status,
    autoCheckReasons: autoCheck.reasons
  };
}

export async function runSlipAutoReviewById(slipId: string): Promise<AutoReviewResult> {
  const supabase = createServiceClient();
  const { data: slip, error } = await supabase
    .from("slip_submissions")
    .select("*")
    .eq("id", slipId)
    .single();

  if (error) throw error;
  if (slip.status === "verified") {
    return {
      shouldVerify: true,
      status: "verified",
      autoCheckStatus: slip.auto_check_status ?? "already_verified",
      autoCheckReasons: slip.auto_check_reasons ?? ["already_verified"]
    };
  }
  if (slip.status !== "manual_review") {
    return {
      shouldVerify: false,
      status: "manual_review",
      autoCheckStatus: slip.auto_check_status ?? "skipped",
      autoCheckReasons: [`slip_status_${slip.status}`]
    };
  }
  if (!slip.storage_bucket || !slip.storage_path) {
    throw new Error("ไม่พบไฟล์สลิปสำหรับตรวจอัตโนมัติ");
  }

  const downloaded = await supabase.storage.from(slip.storage_bucket).download(slip.storage_path);
  if (downloaded.error) throw downloaded.error;

  const normalizedBuffer = Buffer.from(await downloaded.data.arrayBuffer());
  const slipQrPayload = await readSlipQrPayload(normalizedBuffer).catch(() => null);
  const parsedQr = slipQrPayload ? parseEmvQr(slipQrPayload) : null;

  const result = await runAutoReviewForSlip({
    slipId: slip.id,
    eventId: slip.event_id,
    paymentTargetId: slip.payment_target_id,
    lineUserDbId: slip.line_user_id,
    slipRef: slip.slip_ref,
    normalizedBuffer,
    amountExpected: slip.amount_expected,
    qrAmount: parsedQr?.amount ?? null,
    qrProxyId: parsedQr?.promptpayId ?? null
  });

  if (!result.shouldVerify) {
    await notifyAdminSlipReview(slip.id).catch((notifyError) => {
      console.error("slip review notification failed", notifyError);
    });
  }

  return result;
}

export async function uploadSlipImage(input: UploadSlipInput) {
  const supabase = createServiceClient();
  const normalized = await normalizeSlipImage(input.sourceBuffer);
  const imageHash = hashImage(normalized);
  const slipQrPayload = await readSlipQrPayload(input.sourceBuffer).catch(() => null);
  const slipRef = slipQrPayload
    ? `qr:${crypto.createHash("sha256").update(slipQrPayload).digest("hex")}`
    : null;
  // Parse EMV QR payload เพื่อตรวจยอดและผู้รับโดยไม่ใช้ API ภายนอก
  const parsedQr = slipQrPayload ? parseEmvQr(slipQrPayload) : null;
  const now = new Date();
  const datePart = now.toISOString().replace(/[:.]/g, "-");
  const targetSegment = input.paymentTargetId ?? "no-target";
  const amount = Number(input.amountExpected ?? 0).toFixed(2);

  const duplicate = await findDuplicateSlip(supabase, imageHash, slipRef);
  if (duplicate) {
    await auditDuplicateSlipAttempt(supabase, input, duplicate.duplicate, duplicate.reason, {
      imageHash,
      slipRef
    });
    return {
      status: "duplicate_blocked",
      autoCheckStatus: "duplicate_blocked",
      autoCheckReasons: [duplicate.reason],
      duplicateOfId: duplicate.duplicate.id
    } satisfies UploadSlipResult;
  }

  // Use payment_target_id (UUID) instead of person name — avoids Thai-character URL encoding issues
  const path = `events/${input.eventId}/manual_review/${targetSegment}_${amount}_${datePart}_${imageHash.slice(0, 12)}.jpg`;
  // Human-readable name kept only for download Content-Disposition
  const originalFilename = `${input.personName ?? "unknown"}_${amount}.jpg`;

  const uploaded = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(path, normalized, {
      contentType: "image/jpeg",
      upsert: false
    });

  if (uploaded.error) {
    throw uploaded.error;
  }

  const inserted = await supabase
    .from("slip_submissions")
    .insert({
      event_id: input.eventId,
      payment_target_id: input.paymentTargetId ?? null,
      line_user_id: input.lineUserDbId ?? null,
      line_message_id: input.lineMessageId ?? null,
      storage_bucket: STORAGE_BUCKET,
      storage_path: path,
      original_filename: originalFilename,
      file_size: normalized.byteLength,
      mime_type: "image/jpeg",
      image_hash: imageHash,
      slip_ref: slipRef,
      amount_expected: input.amountExpected ?? null,
      status: "manual_review"
    })
    .select("*")
    .single();

  if (inserted.error) {
    await supabase.storage.from(STORAGE_BUCKET).remove([path]);
    if (isDuplicateSlipConstraintError(inserted.error)) {
      const concurrentDuplicate = await findDuplicateSlip(supabase, imageHash, slipRef);
      if (concurrentDuplicate) {
        await auditDuplicateSlipAttempt(
          supabase,
          input,
          concurrentDuplicate.duplicate,
          concurrentDuplicate.reason,
          { imageHash, slipRef }
        );
        return {
          status: "duplicate_blocked",
          autoCheckStatus: "duplicate_blocked",
          autoCheckReasons: [concurrentDuplicate.reason],
          duplicateOfId: concurrentDuplicate.duplicate.id
        } satisfies UploadSlipResult;
      }
    }
    throw inserted.error;
  }

  if (input.paymentTargetId) {
    const replaced = await supabase
      .from("slip_submissions")
      .update({ replaced_by_slip_id: inserted.data.id })
      .eq("payment_target_id", input.paymentTargetId)
      .is("metadata_deleted_at", null)
      .is("replaced_by_slip_id", null)
      .neq("id", inserted.data.id)
      .not("status", "in", "(verified,deleted)");

    if (replaced.error && !isMissingColumnError(replaced.error, "replaced_by_slip_id")) {
      await supabase.from("slip_submissions").delete().eq("id", inserted.data.id);
      await supabase.storage.from(STORAGE_BUCKET).remove([path]);
      throw replaced.error;
    }
  }

  if (input.paymentTargetId) {
    await supabase
      .from("payment_targets")
      .update({
        status: "manual_review",
        paid_at: null,
        paid_slip_submission_id: null
      })
      .eq("id", input.paymentTargetId)
      .neq("status", "verified");
  }

  if (input.autoReviewMode === "deferred") {
    const queued = await supabase
      .from("slip_submissions")
      .update({
        auto_check_status: "queued",
        auto_check_reasons: ["auto_review_deferred_for_fast_upload"]
      })
      .eq("id", inserted.data.id);

    if (queued.error) throw queued.error;

    return {
      id: inserted.data.id,
      status: "manual_review",
      autoCheckStatus: "queued",
      autoCheckReasons: ["auto_review_deferred_for_fast_upload"]
    } satisfies UploadSlipResult;
  }

  const autoReview = await runAutoReviewForSlip({
    slipId: inserted.data.id,
    eventId: input.eventId,
    paymentTargetId: input.paymentTargetId ?? null,
    lineUserDbId: input.lineUserDbId ?? null,
    slipRef,
    normalizedBuffer: normalized,
    amountExpected: input.amountExpected ?? null,
    qrAmount: parsedQr?.amount ?? null,
    qrProxyId: parsedQr?.promptpayId ?? null
  });

  if (!autoReview.shouldVerify) {
    await notifyAdminSlipReview(inserted.data.id).catch((notifyError) => {
      console.error("slip review notification failed", notifyError);
    });
  }

  return {
    id: inserted.data.id,
    status: autoReview.status,
    autoCheckStatus: autoReview.autoCheckStatus,
    autoCheckReasons: autoReview.autoCheckReasons
  } satisfies UploadSlipResult;
}

export async function downloadLineContent(messageId: string) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error("ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN");

  const response = await fetch(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    {
      headers: {
        authorization: `Bearer ${token}`
      }
    }
  );

  if (!response.ok) {
    throw new Error(`ดาวน์โหลดรูปจาก LINE ไม่สำเร็จ: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType: response.headers.get("content-type")
  };
}
