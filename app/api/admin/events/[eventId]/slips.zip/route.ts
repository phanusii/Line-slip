import archiver from "archiver";
import { NextRequest, NextResponse } from "next/server";
import { PassThrough, Readable } from "node:stream";
import { formatApiError } from "@/lib/api-error";
import { actorFromRequest, assertAdmin } from "@/lib/auth";
import { safeFilePart } from "@/lib/format";
import { createServiceClient } from "@/lib/supabase/server";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ eventId: string }> }
) {
  try {
    assertAdmin(request);
    const { eventId } = await context.params;
    const supabase = createServiceClient();

    const [event, slips] = await Promise.all([
      supabase.from("events").select("name,slug").eq("id", eventId).single(),
      supabase
        .from("slip_submissions")
        .select("id,storage_bucket,storage_path,status,amount_expected,created_at,payment_targets(display_name)")
        .eq("event_id", eventId)
        .is("metadata_deleted_at", null)
        .not("storage_path", "is", null)
        .order("created_at")
    ]);

    if (event.error) throw event.error;
    if (slips.error) throw slips.error;

    const archive = archiver("zip", { zlib: { level: 9 } });
    const stream = new PassThrough();
    archive.pipe(stream);

    queueMicrotask(async () => {
      try {
        for (const slip of slips.data) {
          if (!slip.storage_path) continue;
          const file = await supabase.storage
            .from(slip.storage_bucket)
            .download(slip.storage_path);
          if (file.error) continue;

          const buffer = Buffer.from(await file.data.arrayBuffer());
          const target = Array.isArray(slip.payment_targets)
            ? slip.payment_targets[0]
            : slip.payment_targets;
          const person = safeFilePart(target?.display_name ?? "unknown");
          const amount = Number(slip.amount_expected ?? 0).toFixed(2);
          const date = new Date(slip.created_at).toISOString().slice(0, 10);
          archive.append(buffer, {
            name: `${person}_${amount}_${slip.status}_${date}_${slip.id.slice(0, 8)}.jpg`
          });
        }

        await archive.finalize();
      } catch (error) {
        archive.destroy(error as Error);
      }
    });

    await supabase.from("audit_logs").insert({
      ...actorFromRequest(request),
      action: "download_event_slips_zip",
      entity_type: "event",
      entity_id: eventId,
      event_id: eventId
    });

    return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${event.data.slug}-slips.zip"`
      }
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}
