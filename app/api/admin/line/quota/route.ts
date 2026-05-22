import { NextRequest, NextResponse } from "next/server";
import { formatApiError } from "@/lib/api-error";
import { assertAdmin } from "@/lib/auth";
import { getLineMessageQuota } from "@/lib/line";

export async function GET(request: NextRequest) {
  try {
    assertAdmin(request, "viewer");
    const quota = await getLineMessageQuota();
    return NextResponse.json({ ...quota, checkedAt: new Date().toISOString() });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json(
      {
        type: "error",
        limit: null,
        used: null,
        remaining: null,
        canPush: false,
        checkedAt: new Date().toISOString(),
        error: formatApiError(error)
      },
      { status: 200 }
    );
  }
}
