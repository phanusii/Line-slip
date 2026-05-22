import { NextRequest, NextResponse } from "next/server";
import { assertAdmin, actorFromRequest } from "@/lib/auth";
import { formatApiError } from "@/lib/api-error";
import { liffUri } from "@/lib/line";
import {
  createRichMenu,
  deleteRichMenu,
  generateFourButtonMenuImage,
  listRichMenus,
  setDefaultRichMenu,
  uploadRichMenuImage
} from "@/lib/rich-menu";
import { createServiceClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  let richMenuId: string | null = null;

  try {
    assertAdmin(request);
    const supabase = createServiceClient();

    const { data: settingsRows } = await supabase
      .from("settings")
      .select("key,value")
      .eq("key", "contact_url");

    const contactUrl = settingsRows?.[0]?.value ?? "";

    const image = await generateFourButtonMenuImage();

    const W = 2500;
    const H = 1686;
    const col = Math.floor(W / 2);
    const row = Math.floor(H / 2);

    const richMenu = await createRichMenu({
      size: { width: W, height: H },
      selected: true,
      name: "line-slip-4btn",
      chatBarText: "เมนู",
      areas: [
        {
          bounds: { x: 0, y: 0, width: col, height: row },
          action: { type: "uri", label: "สร้าง QR", uri: liffUri("pay") }
        },
        {
          bounds: { x: col, y: 0, width: W - col, height: row },
          action: { type: "uri", label: "ส่งสลิป", uri: liffUri("slip") }
        },
        {
          bounds: { x: 0, y: row, width: col, height: H - row },
          action: { type: "uri", label: "สถานะ", uri: liffUri("me") }
        },
        {
          bounds: { x: col, y: row, width: W - col, height: H - row },
          action: contactUrl
            ? { type: "uri", label: "📞 ติดต่อ", uri: contactUrl }
            : { type: "message", label: "📞 ติดต่อ", text: "ติดต่อ" }
        }
      ]
    });

    richMenuId = richMenu.richMenuId;
    await uploadRichMenuImage(richMenuId, image, "image/png");
    await setDefaultRichMenu(richMenuId);

    // Delete old menus with same name to avoid accumulation
    try {
      const { richmenus } = await listRichMenus();
      await Promise.all(
        richmenus
          .filter((m) => m.richMenuId !== richMenuId)
          .map((m) => deleteRichMenu(m.richMenuId).catch(() => null))
      );
    } catch {
      // Non-critical: old menu cleanup failure should not fail the request
    }

    await supabase.from("audit_logs").insert({
      ...actorFromRequest(request),
      action: "publish_compact_rich_menu",
      entity_type: "rich_menu",
      after_data: { richMenuId, contactUrl },
      reason: "เผยแพร่ Rich Menu 4 ปุ่มจากแดชบอร์ด"
    });

    return NextResponse.json({ ok: true, richMenuId });
  } catch (error) {
    if (richMenuId) {
      await deleteRichMenu(richMenuId).catch(() => null);
    }
    if (error instanceof Response) return error;
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}
