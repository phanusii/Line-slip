import { NextRequest, NextResponse } from "next/server";
import { actorFromRequest, assertAdmin } from "@/lib/auth";
import { STORAGE_BUCKET } from "@/lib/env";
import { createServiceClient } from "@/lib/supabase/server";

type CleanupMode = "files" | "files_and_metadata" | "event";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ eventId: string }> }
) {
  try {
    assertAdmin(request);
    const { eventId } = await context.params;
    const body = (await request.json()) as {
      mode: CleanupMode;
      confirmName: string;
      reason?: string;
    };

    const supabase = createServiceClient();
    const { data: event, error: eventError } = await supabase
      .from("events")
      .select("*")
      .eq("id", eventId)
      .single();

    if (eventError) throw eventError;

    if (!body.confirmName || body.confirmName !== event.name) {
      return NextResponse.json(
        { error: "Confirmation name does not match event name." },
        { status: 400 }
      );
    }

    const { data: slips, error: slipsError } = await supabase
      .from("slip_submissions")
      .select("id,storage_path,status,file_deleted_at,metadata_deleted_at")
      .eq("event_id", eventId);

    if (slipsError) throw slipsError;

    const storagePaths = slips
      .map((slip) => slip.storage_path)
      .filter((path): path is string => Boolean(path));

    if (storagePaths.length > 0) {
      const removed = await supabase.storage.from(STORAGE_BUCKET).remove(storagePaths);
      if (removed.error) throw removed.error;
    }

    const actor = actorFromRequest(request);
    const now = new Date().toISOString();

    if (body.mode === "files") {
      const updated = await supabase
        .from("slip_submissions")
        .update({ storage_path: null, file_deleted_at: now })
        .eq("event_id", eventId)
        .is("file_deleted_at", null);
      if (updated.error) throw updated.error;
    }

    if (body.mode === "files_and_metadata") {
      const updated = await supabase
        .from("slip_submissions")
        .update({ storage_path: null, file_deleted_at: now, metadata_deleted_at: now })
        .eq("event_id", eventId);
      if (updated.error) throw updated.error;
    }

    if (body.mode === "event") {
      const archived = await supabase
        .from("events")
        .update({ archived_at: now, is_open: false })
        .eq("id", eventId);
      if (archived.error) throw archived.error;

      const updatedSlips = await supabase
        .from("slip_submissions")
        .update({ storage_path: null, file_deleted_at: now, metadata_deleted_at: now })
        .eq("event_id", eventId);
      if (updatedSlips.error) throw updatedSlips.error;
    }

    const audit = await supabase.from("audit_logs").insert({
      ...actor,
      action: `cleanup_${body.mode}`,
      entity_type: "event",
      entity_id: eventId,
      event_id: eventId,
      before_data: { event, slips },
      after_data: { deleted_files: storagePaths.length, mode: body.mode },
      reason: body.reason ?? null
    });

    if (audit.error) throw audit.error;

    return NextResponse.json({
      ok: true,
      mode: body.mode,
      deleted_files: storagePaths.length
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
