import crypto from "node:crypto";
import jsQR from "jsqr";
import sharp from "sharp";
import { notifyAdminSlipReview } from "@/lib/admin-review";
import { STORAGE_BUCKET } from "@/lib/env";
import { applySlipStatus } from "@/lib/slip-status";
import { getBooleanSetting, getSettings, getSlipVerificationProvider } from "@/lib/settings";
import {
  acquireSlipOkQuotaLease,
  disableSlipOkToManual,
  getSlipOkQuota,
  isSlipOkQuotaExhausted,
  recordSlipOkUsage,
  releaseSlipOkQuotaLease,
  type SlipOkQuotaSnapshot,
  verifySlipWithSlipOk
} from "@/lib/slipok";
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
  notifyAdmin?: boolean;
  deferProviderCheck?: boolean;
};

export type UploadSlipResult = {
  id?: string;
  status: "manual_review" | "verified" | "duplicate_blocked";
  autoCheckStatus?: string | null;
  autoCheckReasons?: string[];
  duplicateOfId?: string;
};

type ProviderCheck = {
  verificationProvider: "manual" | "slipok";
  checkStatus: string;
  reasons: string[];
  amountDetected: number | null;
  response: unknown;
  reference: string | null;
  checkedAt: string | null;
  shouldAutoApprove: boolean;
  quotaBefore?: SlipOkQuotaSnapshot | null;
  quotaAfter?: SlipOkQuotaSnapshot | null;
  usageStatus?: string | null;
  disableReason?: string | null;
};

function canReuseUploadedJpeg(source: Buffer, mimeType?: string | null) {
  const normalizedMime = mimeType?.toLowerCase() ?? "";
  const isJpeg = normalizedMime === "image/jpeg" || normalizedMime === "image/jpg";
  return isJpeg && source.byteLength <= 900_000;
}

export async function normalizeSlipImage(source: Buffer, mimeType?: string | null) {
  if (canReuseUploadedJpeg(source, mimeType)) return source;

  return sharp(source, { failOn: "none" })
    .rotate()
    .resize({ width: 1280, withoutEnlargement: true })
    .jpeg({ quality: 72, mozjpeg: true })
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

export async function uploadSlipImage(input: UploadSlipInput) {
  const supabase = createServiceClient();
  const normalized = await normalizeSlipImage(input.sourceBuffer, input.mimeType);
  const imageHash = hashImage(normalized);
  const slipQrPayload = await readSlipQrPayload(normalized).catch(() => null);
  const slipRef = slipQrPayload
    ? `qr:${crypto.createHash("sha256").update(slipQrPayload).digest("hex")}`
    : null;
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

  const providerCheck = input.deferProviderCheck
    ? await queuedOrManualProviderCheck(slipRef)
    : await runProviderCheck({
        imageBuffer: normalized,
        amountExpected: input.amountExpected,
        fallbackReference: slipRef
      });

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
      amount_detected: providerCheck.amountDetected,
      status: "manual_review",
      auto_check_status: providerCheck.checkStatus,
      auto_check_reasons: providerCheck.reasons,
      auto_checked_at: providerCheck.checkedAt,
      verification_provider: providerCheck.verificationProvider,
      provider_check_status: providerCheck.checkStatus,
      provider_response: providerCheck.response,
      provider_checked_at: providerCheck.checkedAt,
      provider_reference: providerCheck.reference
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
    const targetUpdated = await supabase
      .from("payment_targets")
      .update({
        status: "manual_review",
        amount_locked_at: new Date().toISOString(),
        paid_at: null,
        paid_slip_submission_id: null
      })
      .eq("id", input.paymentTargetId)
      .neq("status", "verified");
    if (targetUpdated.error) throw targetUpdated.error;
  }

  if (providerCheck.verificationProvider === "slipok" && providerCheck.usageStatus) {
    await recordSlipOkUsage({
      slipId: inserted.data.id,
      quotaBefore: providerCheck.quotaBefore,
      quotaAfter: providerCheck.quotaAfter,
      providerStatus: providerCheck.usageStatus
    }).catch((usageError) => {
      console.error("slipok usage log failed", usageError);
    });
  }

  if (providerCheck.disableReason) {
    await disableSlipOkToManual(providerCheck.disableReason).catch((disableError) => {
      console.error("slipok auto disable failed", disableError);
    });
  }

  if (providerCheck.shouldAutoApprove) {
    const updatedSlip = await applySlipStatus({
      slipId: inserted.data.id,
      status: "verified",
      reason: "SlipOK ตรวจสลิปผ่านและยอดตรง",
      actor: { actor_email: "system-slipok", actor_role: "viewer" },
      auditAction: "slipok_auto_verified",
      source: "slipok"
    });

    return {
      id: inserted.data.id,
      status: "verified",
      autoCheckStatus: updatedSlip.auto_check_status ?? providerCheck.checkStatus,
      autoCheckReasons: providerCheck.reasons
    } satisfies UploadSlipResult;
  }

  if (input.notifyAdmin !== false) {
    await notifyAdminSlipReview(inserted.data.id).catch((notifyError) => {
      console.error("slip review notification failed", notifyError);
    });
  }

  return {
    id: inserted.data.id,
    status: "manual_review",
    autoCheckStatus: providerCheck.checkStatus,
    autoCheckReasons: providerCheck.reasons
  } satisfies UploadSlipResult;
}

async function runProviderCheck(input: {
  imageBuffer: Buffer;
  amountExpected?: number | null;
  fallbackReference: string | null;
}): Promise<ProviderCheck> {
  const settings = await getSettings([
    "slip_verification_provider",
    "slipok_api_key",
    "slipok_branch_id",
    "slipok_log_enabled",
    "slipok_auto_approve_enabled",
    "telegram_bot_token",
    "telegram_chat_id"
  ]);
  const provider = getSlipVerificationProvider(settings);
  const manualCheck: ProviderCheck = {
    verificationProvider: "manual",
    checkStatus: "disabled",
    reasons: ["manual_review_only"],
    amountDetected: null,
    response: null,
    reference: input.fallbackReference,
    checkedAt: new Date().toISOString(),
    shouldAutoApprove: false
  };

  if (provider !== "slipok") return manualCheck;

  const leaseToken = await acquireSlipOkQuotaLease().catch((error) => {
    console.error("slipok quota lease failed", error);
    return null;
  });

  if (!leaseToken) {
    return {
      ...manualCheck,
      verificationProvider: "slipok",
      checkStatus: "slipok_busy",
      reasons: ["slipok_busy"],
      response: { error: "SlipOK verification queue is busy or unavailable" },
      usageStatus: "slipok_busy"
    };
  }

  try {
    const quotaBefore = await getSlipOkQuota(settings).catch((error) => ({
      ok: false,
      quota: null,
      overQuota: null,
      used: null,
      remaining: null,
      endDate: null,
      raw: null,
      error: error instanceof Error ? error.message : String(error)
    }) satisfies SlipOkQuotaSnapshot);

    if (!quotaBefore.ok) {
      return {
        ...manualCheck,
        verificationProvider: "slipok",
        checkStatus: "quota_check_failed",
        reasons: ["slipok_quota_check_failed"],
        response: { quotaBefore },
        usageStatus: "quota_check_failed"
      };
    }

    if (isSlipOkQuotaExhausted(quotaBefore)) {
      return {
        ...manualCheck,
        verificationProvider: "slipok",
        checkStatus: "skipped_quota_exhausted",
        reasons: ["slipok_quota_exhausted"],
        response: { quotaBefore },
        quotaBefore,
        usageStatus: "skipped_quota_exhausted",
        disableReason: "SlipOK เหลือ 1 ครั้งหรือน้อยกว่า ระบบจึงปิดกลับเป็น Manual เพื่อไม่ให้เกิดค่าใช้จ่าย"
      };
    }

    const checkedAt = new Date().toISOString();
    const verification = await verifySlipWithSlipOk({
      settings,
      imageBuffer: input.imageBuffer,
      amountExpected: input.amountExpected
    }).catch((error) => ({
      ok: false,
      passed: false,
      checkStatus: "api_error",
      reasons: ["slipok_api_error"],
      amountDetected: null,
      reference: null,
      raw: null,
      error: error instanceof Error ? error.message : String(error)
    }));

    const quotaAfter = await getSlipOkQuota(settings).catch((error) => ({
      ok: false,
      quota: null,
      overQuota: null,
      used: null,
      remaining: null,
      endDate: null,
      raw: null,
      error: error instanceof Error ? error.message : String(error)
    }) satisfies SlipOkQuotaSnapshot);
    const shouldAutoApprove =
      verification.passed &&
      getBooleanSetting(settings, "slipok_auto_approve_enabled", true);

    return {
      verificationProvider: "slipok",
      checkStatus: verification.passed ? "passed" : verification.checkStatus,
      reasons: verification.reasons.length ? verification.reasons : ["slipok_manual_review"],
      amountDetected: verification.amountDetected,
      response: {
        slipok: verification.raw,
        error: verification.error ?? null,
        quotaBefore,
        quotaAfter
      },
      reference: verification.reference ?? input.fallbackReference,
      checkedAt,
      shouldAutoApprove,
      quotaBefore,
      quotaAfter,
      usageStatus: verification.passed ? "passed" : verification.checkStatus,
      disableReason: isSlipOkQuotaExhausted(quotaAfter)
        ? "SlipOK เหลือ 1 ครั้งหรือน้อยกว่าหลังตรวจสลิป ระบบจึงปิดกลับเป็น Manual เพื่อไม่ให้เกิดค่าใช้จ่าย"
        : null
    };
  } finally {
    await releaseSlipOkQuotaLease(leaseToken).catch((error) => {
      console.error("slipok quota lease release failed", error);
    });
  }
}

async function queuedOrManualProviderCheck(fallbackReference: string | null): Promise<ProviderCheck> {
  const settings = await getSettings(["slip_verification_provider"]);
  if (getSlipVerificationProvider(settings) !== "slipok") {
    return {
      verificationProvider: "manual",
      checkStatus: "disabled",
      reasons: ["manual_review_only"],
      amountDetected: null,
      response: null,
      reference: fallbackReference,
      checkedAt: new Date().toISOString(),
      shouldAutoApprove: false
    };
  }

  return {
    verificationProvider: "slipok",
    checkStatus: "slipok_queued",
    reasons: ["slipok_queued"],
    amountDetected: null,
    response: null,
    reference: fallbackReference,
    checkedAt: new Date().toISOString(),
    shouldAutoApprove: false
  };
}

export async function processDeferredSlipVerification(input: {
  slipId: string;
  notifyAdminOnManual?: boolean;
}) {
  const supabase = createServiceClient();
  const { data: slip, error } = await supabase
    .from("slip_submissions")
    .select("*")
    .eq("id", input.slipId)
    .maybeSingle();

  if (error) throw error;
  if (!slip || slip.status !== "manual_review") return { ok: true, skipped: "not_manual_review" };
  if (slip.verification_provider !== "slipok" || slip.provider_check_status !== "slipok_queued") {
    if (input.notifyAdminOnManual !== false) await notifyAdminSlipReview(input.slipId);
    return { ok: true, skipped: "not_slipok_queued" };
  }
  if (!slip.storage_bucket || !slip.storage_path) {
    if (input.notifyAdminOnManual !== false) await notifyAdminSlipReview(input.slipId);
    return { ok: true, skipped: "missing_storage" };
  }

  const downloaded = await supabase.storage.from(slip.storage_bucket).download(slip.storage_path);
  if (downloaded.error) throw downloaded.error;
  const imageBuffer = Buffer.from(await downloaded.data.arrayBuffer());

  const providerCheck = await runProviderCheck({
    imageBuffer,
    amountExpected: slip.amount_expected === null ? null : Number(slip.amount_expected),
    fallbackReference: slip.slip_ref ?? null
  });

  const updated = await supabase
    .from("slip_submissions")
    .update({
      amount_detected: providerCheck.amountDetected,
      auto_check_status: providerCheck.checkStatus,
      auto_check_reasons: providerCheck.reasons,
      auto_checked_at: providerCheck.checkedAt,
      verification_provider: providerCheck.verificationProvider,
      provider_check_status: providerCheck.checkStatus,
      provider_response: providerCheck.response,
      provider_checked_at: providerCheck.checkedAt,
      provider_reference: providerCheck.reference
    })
    .eq("id", input.slipId)
    .eq("status", "manual_review")
    .select("id,status")
    .maybeSingle();

  if (updated.error) throw updated.error;
  if (!updated.data) return { ok: true, skipped: "status_changed" };

  if (providerCheck.verificationProvider === "slipok" && providerCheck.usageStatus) {
    await recordSlipOkUsage({
      slipId: input.slipId,
      quotaBefore: providerCheck.quotaBefore,
      quotaAfter: providerCheck.quotaAfter,
      providerStatus: providerCheck.usageStatus
    }).catch((usageError) => {
      console.error("slipok usage log failed", usageError);
    });
  }

  if (providerCheck.disableReason) {
    await disableSlipOkToManual(providerCheck.disableReason).catch((disableError) => {
      console.error("slipok auto disable failed", disableError);
    });
  }

  if (providerCheck.shouldAutoApprove) {
    await applySlipStatus({
      slipId: input.slipId,
      status: "verified",
      reason: "SlipOK ตรวจสลิปผ่านและยอดตรง",
      actor: { actor_email: "system-slipok", actor_role: "viewer" },
      auditAction: "slipok_auto_verified",
      source: "slipok"
    });
    return { ok: true, status: "verified" };
  }

  if (input.notifyAdminOnManual !== false) {
    await notifyAdminSlipReview(input.slipId);
  }

  return { ok: true, status: "manual_review", autoCheckStatus: providerCheck.checkStatus };
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
