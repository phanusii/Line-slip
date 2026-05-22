import crypto from "node:crypto";
import jsQR from "jsqr";
import sharp from "sharp";
import { notifyAdminSlipReview } from "@/lib/admin-review";
import { STORAGE_BUCKET } from "@/lib/env";
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
};

export type UploadSlipResult = {
  id: string;
  status: "manual_review" | "duplicate_slip";
  duplicateOfId?: string;
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

export async function readSlipQrRef(buffer: Buffer) {
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
  return `qr:${crypto.createHash("sha256").update(decoded.data).digest("hex")}`;
}

export async function uploadSlipImage(input: UploadSlipInput) {
  const supabase = createServiceClient();
  const normalized = await normalizeSlipImage(input.sourceBuffer);
  const imageHash = hashImage(normalized);
  const slipRef = await readSlipQrRef(input.sourceBuffer).catch(() => null);
  const now = new Date();
  const datePart = now.toISOString().replace(/[:.]/g, "-");
  const targetSegment = input.paymentTargetId ?? "no-target";
  const amount = Number(input.amountExpected ?? 0).toFixed(2);

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

  const qrDuplicate = slipRef
    ? await supabase
        .from("slip_submissions")
        .select("id,event_id,payment_target_id")
        .eq("slip_ref", slipRef)
        .is("metadata_deleted_at", null)
        .limit(1)
        .maybeSingle()
    : { data: null, error: null };

  if (qrDuplicate.error) {
    throw qrDuplicate.error;
  }

  const duplicate = qrDuplicate.data ?? imageDuplicate.data;
  if (duplicate) {
    const duplicateInsert = await supabase
      .from("slip_submissions")
      .insert({
        event_id: input.eventId,
        payment_target_id: input.paymentTargetId ?? null,
        line_user_id: input.lineUserDbId ?? null,
        line_message_id: input.lineMessageId ?? null,
        storage_bucket: STORAGE_BUCKET,
        storage_path: null,
        original_filename: `${input.personName ?? "unknown"}_${amount}_duplicate.jpg`,
        file_size: 0,
        mime_type: "image/jpeg",
        image_hash: imageHash,
        slip_ref: null,
        amount_expected: input.amountExpected ?? null,
        status: "duplicate_slip",
        rejection_reason: `duplicate ${qrDuplicate.data ? "slip_ref" : "image_hash"} of slip ${duplicate.id}`
      })
      .select("id,status")
      .single();

    if (duplicateInsert.error) {
      throw duplicateInsert.error;
    }

    if (input.paymentTargetId) {
      await supabase
        .from("payment_targets")
        .update({ status: "duplicate_slip" })
        .eq("id", input.paymentTargetId)
        .neq("status", "verified");
    }

    return {
      id: duplicateInsert.data.id,
      status: "duplicate_slip",
      duplicateOfId: duplicate.id
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
    throw inserted.error;
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

  await notifyAdminSlipReview(inserted.data.id);

  return {
    id: inserted.data.id,
    status: "manual_review"
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
