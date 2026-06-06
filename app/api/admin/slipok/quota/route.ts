import { NextRequest, NextResponse } from "next/server";
import { formatApiError } from "@/lib/api-error";
import { assertAdmin } from "@/lib/auth";
import { getSettings, getSlipVerificationProvider } from "@/lib/settings";
import {
  currentBangkokMonthKey,
  disableSlipOkToManual,
  getSlipOkQuota,
  getSlipOkUsedThisMonth,
  isSlipOkQuotaExhausted
} from "@/lib/slipok";

export async function GET(request: NextRequest) {
  try {
    assertAdmin(request, "viewer");
    const settings = await getSettings([
      "slip_verification_provider",
      "slipok_api_key",
      "slipok_branch_id",
      "slipok_disabled_reason",
      "slipok_disabled_at"
    ]);
    const quota = await getSlipOkQuota(settings);
    const monthKey = currentBangkokMonthKey();
    const usedThisMonth = await getSlipOkUsedThisMonth(monthKey).catch(() => 0);

    if (getSlipVerificationProvider(settings) === "slipok" && isSlipOkQuotaExhausted(quota)) {
      const reason = "SlipOK เหลือ 1 ครั้งหรือน้อยกว่า ระบบจึงปิดเป็น Manual เพื่อป้องกันค่าใช้จ่าย";
      await disableSlipOkToManual(reason);
      settings.slip_verification_provider = "manual";
      settings.slipok_disabled_reason = reason;
      settings.slipok_disabled_at = new Date().toISOString();
    }

    return NextResponse.json({
      provider: getSlipVerificationProvider(settings),
      enabled: getSlipVerificationProvider(settings) === "slipok",
      quota,
      usedThisMonth,
      monthKey,
      disabledReason: settings.slipok_disabled_reason ?? "",
      disabledAt: settings.slipok_disabled_at ?? "",
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: formatApiError(error) }, { status: 200 });
  }
}
