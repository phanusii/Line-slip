import crypto from "node:crypto";
import sharp from "sharp";
import { STORAGE_BUCKET } from "@/lib/env";
import { createServiceClient } from "@/lib/supabase/server";
import { verifySlip, type SlipVerifyResult } from "@/lib/slip-verify";

type UploadSlipInput = {
  eventId: string;
  eventSlug: string;
  paymentTargetId?: string | null;
  personName?: string | null;
  amountExpected?: number | null;
  sourceBuffer: Buffer;
  mimeType?: string | null;
  lineMessageId?: string | null;
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

export async function uploadSlipImage(input: UploadSlipInput) {
  const supabase = createServiceClient();
  const normalized = await normalizeSlipImage(input.sourceBuffer);
  const imageHash = hashImage(normalized);
  const now = new Date();
  const datePart = now.toISOString().replace(/[:.]/g, "-");
  const targetSegment = input.paymentTargetId ?? "no-target";
  const amount = Number(input.amountExpected ?? 0).toFixed(2);
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
      line_message_id: input.lineMessageId ?? null,
      storage_bucket: STORAGE_BUCKET,
      storage_path: path,
      original_filename: originalFilename,
      file_size: normalized.byteLength,
      mime_type: "image/jpeg",
      image_hash: imageHash,
      amount_expected: input.amountExpected ?? null,
      status: "manual_review"
    })
    .select("*")
    .single();

  if (inserted.error) {
    await supabase.storage.from(STORAGE_BUCKET).remove([path]);
    throw inserted.error;
  }

  // ── Auto-verify with EasySlip ────────────────────────────────────────────
  // Use original (pre-compression) buffer for better QR readability.
  const verifyResult: SlipVerifyResult = await verifySlip(input.sourceBuffer);

  let finalStatus: "verified" | "amount_mismatch" | "duplicate_slip" | "manual_review" =
    "manual_review";
  let finalPath = path;

  if (verifyResult.ok) {
    const expected = Number(input.amountExpected ?? 0);
    const TOLERANCE = 1; // ±1 บาท

    if (Math.abs(verifyResult.amount - expected) <= TOLERANCE) {
      finalStatus = "verified";
      // Move file to verified/ folder
      const verifiedPath = path.replace("/manual_review/", "/verified/");
      const moved = await supabase.storage
        .from(STORAGE_BUCKET)
        .move(path, verifiedPath);
      if (!moved.error) finalPath = verifiedPath;
    } else {
      finalStatus = "amount_mismatch";
    }
  } else if (verifyResult.reason === "duplicate") {
    finalStatus = "duplicate_slip";
  }
  // "not_configured" | "invalid_slip" | "api_error" → stays "manual_review"

  // Update slip record with verification results
  await supabase
    .from("slip_submissions")
    .update({
      status: finalStatus,
      storage_path: finalPath,
      ...(verifyResult.ok && {
        amount_detected: verifyResult.amount,
        slip_ref: verifyResult.slipRef,
        transfer_datetime: verifyResult.transferDatetime ?? undefined
      })
    })
    .eq("id", inserted.data.id);

  // If auto-verified → mark payment_target as paid
  if (finalStatus === "verified" && input.paymentTargetId) {
    await supabase
      .from("payment_targets")
      .update({
        status: "verified",
        paid_at: new Date().toISOString(),
        paid_slip_submission_id: inserted.data.id
      })
      .eq("id", input.paymentTargetId)
      .neq("status", "verified"); // idempotent
  }

  return { ...inserted.data, status: finalStatus, verifyResult };
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
