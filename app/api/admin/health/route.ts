import { NextRequest, NextResponse } from "next/server";
import { assertAdmin } from "@/lib/auth";
import { getAdminHealthReport } from "@/lib/admin-health";
import { formatApiError } from "@/lib/api-error";

export async function GET(request: NextRequest) {
  try {
    assertAdmin(request, "viewer");
    const report = await getAdminHealthReport();
    return NextResponse.json(report, { status: report.ok ? 200 : 503 });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json(
      {
        ok: false,
        message: "ตรวจสุขภาพระบบไม่สำเร็จ",
        checkedAt: new Date().toISOString(),
        error: formatApiError(error)
      },
      { status: 500 }
    );
  }
}
