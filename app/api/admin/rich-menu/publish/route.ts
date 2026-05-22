import sharp from "sharp";
import { NextRequest, NextResponse } from "next/server";
import { formatApiError } from "@/lib/api-error";
import { actorFromRequest, assertAdmin } from "@/lib/auth";
import {
  createRichMenu,
  deleteRichMenu,
  RichMenuArea,
  setDefaultRichMenu,
  uploadRichMenuImage
} from "@/lib/rich-menu";
import { createServiceClient } from "@/lib/supabase/server";

type PublishBody = {
  name?: string;
  chatBarText?: string;
  imageDataUrl?: string;
  width?: number;
  height?: number;
  areas?: RichMenuArea[];
  setDefault?: boolean;
};

function parseDataUrl(value: string) {
  const match = value.match(/^data:(image\/png|image\/jpeg);base64,(.+)$/);
  if (!match) throw new Error("รองรับเฉพาะไฟล์ PNG หรือ JPEG");

  return {
    contentType: match[1] as "image/png" | "image/jpeg",
    buffer: Buffer.from(match[2], "base64")
  };
}

function validateAreas(areas: RichMenuArea[], width: number, height: number) {
  if (!areas.length) throw new Error("กรุณาเลือกพื้นที่อย่างน้อย 1 ช่อง");

  for (const area of areas) {
    const { bounds, action } = area;
    if (
      bounds.x < 0 ||
      bounds.y < 0 ||
      bounds.width <= 0 ||
      bounds.height <= 0 ||
      bounds.x + bounds.width > width ||
      bounds.y + bounds.height > height
    ) {
      throw new Error("ขนาดพื้นที่กดใน Rich Menu ไม่ถูกต้อง");
    }

    if (action.type === "uri" && !action.uri) {
      throw new Error("Action แบบลิงก์ต้องมี URL");
    }

    if (action.type === "message" && !action.text) {
      throw new Error("Action แบบข้อความต้องมีข้อความ");
    }
  }
}

export async function POST(request: NextRequest) {
  let richMenuId: string | null = null;

  try {
    assertAdmin(request);
    const body = (await request.json()) as PublishBody;
    const name = String(body.name ?? "เมนูชำระเงิน").trim().slice(0, 30);
    const chatBarText = String(body.chatBarText ?? "เมนู").trim().slice(0, 14);
    const width = Number(body.width ?? 2500);
    const height = Number(body.height ?? 843);
    const areas = body.areas ?? [];

    if (!body.imageDataUrl) throw new Error("กรุณาอัปโหลดรูป Rich Menu");
    if (![843, 1686].includes(height) || width !== 2500) {
      throw new Error("ขนาด Rich Menu ต้องเป็น 2500x843 หรือ 2500x1686");
    }

    validateAreas(areas, width, height);

    const image = parseDataUrl(body.imageDataUrl);
    if (image.buffer.byteLength > 1024 * 1024) {
      throw new Error("รูป Rich Menu ต้องไม่เกิน 1 MB");
    }

    const metadata = await sharp(image.buffer).metadata();
    if (metadata.width !== width || metadata.height !== height) {
      throw new Error(`รูปต้องมีขนาด ${width}x${height}px`);
    }

    const richMenu = await createRichMenu({
      size: { width, height },
      selected: true,
      name,
      chatBarText,
      areas
    });
    richMenuId = richMenu.richMenuId;

    await uploadRichMenuImage(richMenuId, image.buffer, image.contentType);

    if (body.setDefault !== false) {
      await setDefaultRichMenu(richMenuId);
    }

    const supabase = createServiceClient();
    await supabase.from("audit_logs").insert({
      ...actorFromRequest(request),
      action: "publish_rich_menu",
      entity_type: "rich_menu",
      before_data: null,
      after_data: {
        richMenuId,
        name,
        chatBarText,
        size: { width, height },
        area_count: areas.length,
        setDefault: body.setDefault !== false
      },
      reason: "เผยแพร่ Rich Menu จากแดชบอร์ดผู้ดูแล"
    });

    return NextResponse.json({
      ok: true,
      richMenuId
    });
  } catch (error) {
    if (richMenuId) {
      try {
        await deleteRichMenu(richMenuId);
      } catch {
        // Keep the original error. LINE may already have rejected the partial menu.
      }
    }
    if (error instanceof Response) return error;
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}
