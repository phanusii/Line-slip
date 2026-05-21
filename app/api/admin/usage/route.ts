import { NextRequest, NextResponse } from "next/server";
import { assertAdmin } from "@/lib/auth";
import { formatApiError } from "@/lib/api-error";
import { createServiceClient } from "@/lib/supabase/server";

const DB_LIMIT_BYTES = 500 * 1024 * 1024;
const STORAGE_LIMIT_BYTES = 1024 * 1024 * 1024;

export async function GET(request: NextRequest) {
  try {
    assertAdmin(request);
    const supabase = createServiceClient();

    const [slips, targets, events] = await Promise.all([
      supabase
        .from("slip_submissions")
        .select("event_id,file_size,status,storage_path,file_deleted_at,metadata_deleted_at,events(name,slug)")
        .is("metadata_deleted_at", null),
      supabase.from("payment_targets").select("id"),
      supabase.from("events").select("id,name,slug,is_open,archived_at,expected_total")
    ]);

    if (slips.error) throw slips.error;
    if (targets.error) throw targets.error;
    if (events.error) throw events.error;

    const storageUsed = slips.data
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

    for (const event of events.data) {
      perEvent.set(event.id, {
        event_id: event.id,
        event_name: event.name,
        event_slug: event.slug,
        file_count: 0,
        storage_bytes: 0,
        review_count: 0
      });
    }

    for (const slip of slips.data) {
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

    const dbEstimate =
      JSON.stringify(events.data).length +
      JSON.stringify(targets.data).length +
      JSON.stringify(slips.data).length;

    return NextResponse.json({
      database: {
        used_bytes_estimate: dbEstimate,
        limit_bytes: DB_LIMIT_BYTES
      },
      storage: {
        used_bytes: storageUsed,
        limit_bytes: STORAGE_LIMIT_BYTES,
        file_count: slips.data.filter((slip) => slip.storage_path && !slip.file_deleted_at).length
      },
      events: [...perEvent.values()].sort((a, b) => b.storage_bytes - a.storage_bytes)
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}
