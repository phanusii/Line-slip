import { NextRequest, NextResponse } from "next/server";
import { formatApiError } from "@/lib/api-error";
import { requireLineAccessToken } from "@/lib/liff";
import { getSettings } from "@/lib/settings";

export async function GET(request: NextRequest) {
  try {
    await requireLineAccessToken(request);
    const settings = await getSettings(["contact_url"]);
    return NextResponse.json({ contactUrl: settings.contact_url ?? "" });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}
