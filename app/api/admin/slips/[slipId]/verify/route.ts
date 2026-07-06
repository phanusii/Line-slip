import { NextRequest, NextResponse } from "next/server";
import { formatApiError } from "@/lib/api-error";
import { assertAdmin } from "@/lib/auth";
import { processDeferredSlipVerification } from "@/lib/slips";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ slipId: string }> }
) {
  try {
    assertAdmin(request);
    const { slipId } = await context.params;
    const result = await processDeferredSlipVerification({
      slipId,
      notifyAdminOnManual: false,
      force: true
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}
