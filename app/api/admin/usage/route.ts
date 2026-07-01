import { NextRequest, NextResponse } from "next/server";
import { assertAdmin } from "@/lib/auth";
import { formatApiError } from "@/lib/api-error";
import { createServiceClient } from "@/lib/supabase/server";

const DB_LIMIT_BYTES = 500 * 1024 * 1024;
const STORAGE_LIMIT_BYTES = 1024 * 1024 * 1024;

export async function GET(request: NextRequest) {
  try {
    assertAdmin(request, "viewer");
    const supabase = createServiceClient();

    const [slipsResult, eventsResult, dbSizeResult] = await Promise.allSettled([
      supabase
        .from("slip_submissions")
        .select("event_id,file_size,status,storage_path,file_deleted_at,metadata_deleted_at,events(name,slug)")
        .is("metadata_deleted_at", null),
      supabase
        .from("events")
        .select("id,name,slug,is_open,archived_at,expected_total")
        .is("archived_at", null),
      supabase.rpc("get_db_size")
    ]);

    const warnings: string[] = [];
    const slips =
      slipsResult.status === "fulfilled" && !slipsResult.value.error
        ? slipsResult.value.data ?? []
        : [];
    const events =
      eventsResult.status === "fulfilled" && !eventsResult.value.error
        ? eventsResult.value.data ?? []
        : [];

    if (slipsResult.status === "rejected" || (slipsResult.status === "fulfilled" && slipsResult.value.error)) {
      warnings.push("storage_usage_unavailable");
    }
    if (eventsResult.status === "rejected" || (eventsResult.status === "fulfilled" && eventsResult.value.error)) {
      warnings.push("event_usage_unavailable");
    }
    if (dbSizeResult.status === "rejected" || (dbSizeResult.status === "fulfilled" && dbSizeResult.value.error)) {
      warnings.push("database_usage_unavailable");
    }

    const storageUsed = slips
      .filter((slip) => slip.storage_path && !slip.file_deleted_at)
      .reduce((sum, slip) => sum + Number(slip.file_size ?? 0), 0);

    const perEvent = new Map<
      string,
      {
        event_id: string;
        event_name: string;
        event_slug: string;
        file_count: number;
        storage_bytes: number;
        review_count: number;
      }
    >();

    for (const event of events) {
      perEvent.set(event.id, {
        event_id: event.id,
        event_name: event.name,
        event_slug: event.slug,
        file_count: 0,
        storage_bytes: 0,
        review_count: 0
      });
    }

    for (const slip of slips) {
      if (!slip.event_id) continue;
      const row = perEvent.get(slip.event_id);
      if (!row) continue;
      if (slip.storage_path && !slip.file_deleted_at) {
        row.file_count += 1;
        row.storage_bytes += Number(slip.file_size ?? 0);
      }
      if (slip.status === "manual_review") {
        row.review_count += 1;
      }
    }

    const dbUsedBytes =
      dbSizeResult.status === "fulfilled" && !dbSizeResult.value.error ? Number(dbSizeResult.value.data ?? 0) : 0;

    return NextResponse.json({
      database: {
        used_bytes: dbUsedBytes,
        limit_bytes: DB_LIMIT_BYTES
      },
      storage: {
        used_bytes: storageUsed,
        limit_bytes: STORAGE_LIMIT_BYTES,
        file_count: slips.filter((slip) => slip.storage_path && !slip.file_deleted_at).length
      },
      events: [...perEvent.values()].sort((a, b) => b.storage_bytes - a.storage_bytes),
      warnings
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}
