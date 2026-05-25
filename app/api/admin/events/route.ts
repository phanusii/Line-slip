import { NextRequest, NextResponse } from "next/server";
import { actorFromRequest, assertAdmin } from "@/lib/auth";
import { formatApiError } from "@/lib/api-error";
import { createServiceClient } from "@/lib/supabase/server";

type PaymentTargetInput = {
  display_name?: unknown;
  amount_due?: unknown;
  note?: unknown;
};

type NormalizedTarget = {
  display_name: string;
  amount_due: number;
  note: string;
  amount_from_default: boolean;
};

const promptpayTypes = new Set(["phone", "national_id", "ewallet"]);

function validatePromptPayId(value: string | null, type: string) {
  if (!value) return null;
  const digits = value.replace(/[\s-]/g, "");
  if (type === "phone" && !/^0[689]\d{8}$/.test(digits)) {
    return "เบอร์ PromptPay ต้องเป็นเบอร์มือถือไทย 10 หลัก เช่น 089xxxxxxx";
  }
  if (type === "national_id" && !/^\d{13}$/.test(digits)) {
    return "เลขบัตรประชาชน PromptPay ต้องเป็นตัวเลข 13 หลัก";
  }
  if (type === "ewallet" && !/^\d{15}$/.test(digits)) {
    return "e-wallet PromptPay ต้องเป็นตัวเลข 15 หลัก";
  }
  return null;
}

function slugify(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

  return slug || "event";
}

function parseAmount(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return Number.NaN;
  return Number(value.replace(/,/g, "").trim());
}

function parseTargetsText(text: string, defaultAmount: number) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const cells = line.includes("\t")
        ? line.split("\t")
        : line.includes(",")
          ? line.split(",")
          : line.split(/\s{2,}/);
      const cleaned = cells.map((cell) => cell.trim()).filter(Boolean);
      const lineAmountMatch = line.match(/^(.+?)\s+([0-9][0-9,]*(?:\.\d+)?)$/);
      const maybeAmount =
        cleaned.length > 1
          ? parseAmount(cleaned[cleaned.length - 1])
          : lineAmountMatch
            ? parseAmount(lineAmountMatch[2])
            : Number.NaN;
      const hasAmount = Number.isFinite(maybeAmount);

      return {
        display_name: hasAmount
          ? cleaned.length > 1
            ? cleaned.slice(0, -1).join(" ")
            : lineAmountMatch?.[1].trim() ?? line
          : line,
        amount_due: hasAmount ? maybeAmount : defaultAmount,
        note: "",
        amount_from_default: !hasAmount
      };
    })
    .filter((target) => {
      const name = target.display_name.toLowerCase();
      return name !== "ชื่อ" && name !== "name" && name !== "รายชื่อ";
    });
}

function normalizeTargets(payload: unknown, defaultAmount: number) {
  if (!Array.isArray(payload)) return [];

  return payload.map((target) => {
    const input = target as PaymentTargetInput;
    const amount = parseAmount(input.amount_due);
    return {
      display_name: String(input.display_name ?? "").trim(),
      amount_due: Number.isFinite(amount) ? amount : defaultAmount,
      note: input.note ? String(input.note).trim() : "",
      amount_from_default: !Number.isFinite(amount)
    };
  });
}

export async function GET(request: NextRequest) {
  try {
    assertAdmin(request, "viewer");
    const supabase = createServiceClient();

    const { data, error } = await supabase
      .from("events")
      .select(
        "id,name,slug,is_open,expected_total,created_at,payment_targets(id,status,amount_due),slip_submissions(id,status,file_size,storage_path,file_deleted_at,metadata_deleted_at)"
      )
      .is("archived_at", null)
      .order("created_at", { ascending: false });

    if (error) throw error;

    return NextResponse.json({
      events: data.map((event) => {
        const targets = event.payment_targets ?? [];
        const slips = (event.slip_submissions ?? []).filter((slip) => !slip.metadata_deleted_at);
        const paid = targets.filter((target) => target.status === "verified").length;
        const unpaid = targets.filter((target) => target.status !== "verified").length;
        const review = slips.filter((slip) => slip.status === "manual_review").length;
        const storageBytes = slips
          .filter((slip) => slip.storage_path && !slip.file_deleted_at)
          .reduce((sum, slip) => sum + Number(slip.file_size ?? 0), 0);

        return {
          id: event.id,
          name: event.name,
          slug: event.slug,
          is_open: event.is_open,
          expected_total: event.expected_total,
          target_count: targets.length,
          paid_count: paid,
          unpaid_count: unpaid,
          review_count: review,
          slip_count: slips.length,
          storage_bytes: storageBytes
        };
      })
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    assertAdmin(request);
    const supabase = createServiceClient();
    const body = await request.json();

    const name = String(body.name ?? "").trim();
    const promptpayId = String(body.promptpay_id ?? "").trim() || null;
    const promptpayType = promptpayTypes.has(String(body.promptpay_type))
      ? String(body.promptpay_type)
      : "phone";
    const defaultAmount = parseAmount(body.default_amount);
    const targetsText = String(body.targets_text ?? "").trim();
    const fromStructuredTargets = normalizeTargets(body.targets, defaultAmount);
    const fromText = targetsText ? parseTargetsText(targetsText, defaultAmount) : [];
    const rawTargets = fromStructuredTargets.length ? fromStructuredTargets : fromText;

    if (!name) {
      return NextResponse.json({ error: "กรุณากรอกชื่องานเก็บเงิน" }, { status: 400 });
    }

    const promptPayError = validatePromptPayId(promptpayId, promptpayType);
    if (promptPayError) {
      return NextResponse.json({ error: promptPayError }, { status: 400 });
    }

    if (!rawTargets.length) {
      return NextResponse.json(
        { error: "กรุณาใส่รายชื่ออย่างน้อย 1 รายชื่อ" },
        { status: 400 }
      );
    }

    const invalidTarget = rawTargets.find(
      (target) =>
        !target.display_name ||
        !Number.isFinite(target.amount_due) ||
        target.amount_due <= 0
    );

    if (invalidTarget) {
      return NextResponse.json(
        { error: "รายชื่อหรือยอดเงินไม่ถูกต้อง กรุณาตรวจข้อมูลที่วางจากชีต/Excel" },
        { status: 400 }
      );
    }

    const duplicateNames = rawTargets
      .map((target) => target.display_name)
      .filter((nameValue, index, names) => names.indexOf(nameValue) !== index);

    if (duplicateNames.length) {
      return NextResponse.json(
        { error: `มีรายชื่อซ้ำ: ${Array.from(new Set(duplicateNames)).join(", ")}` },
        { status: 400 }
      );
    }

    const expectedTotal = rawTargets.reduce(
      (sum, target) => sum + Number(target.amount_due),
      0
    );
    const slugBase = body.slug ? slugify(String(body.slug)) : slugify(name);
    const slug = `${slugBase}-${Date.now().toString(36)}`;

    const { data: event, error: eventError } = await supabase
      .from("events")
      .insert({
        name,
        slug,
        promptpay_id: promptpayId,
        promptpay_type: promptpayType,
        expected_total: expectedTotal,
        is_open: true
      })
      .select("*")
      .single();

    if (eventError) throw eventError;

    const { error: targetsError } = await supabase.from("payment_targets").insert(
      rawTargets.map((target, index) => ({
        event_id: event.id,
        display_name: target.display_name,
        amount_due: target.amount_due,
        note: target.note || null,
        status: "unpaid",
        sort_order: index
      }))
    );

    if (targetsError) {
      await supabase.from("events").delete().eq("id", event.id);
      throw targetsError;
    }

    await supabase.from("audit_logs").insert({
      ...actorFromRequest(request),
      action: "create_event",
      entity_type: "event",
      entity_id: event.id,
      event_id: event.id,
      after_data: {
        name,
        slug,
        promptpay_id: promptpayId,
        promptpay_type: promptpayType,
        expected_total: expectedTotal,
        target_count: rawTargets.length
      },
      reason: "สร้างงานเก็บเงินจากแดชบอร์ดผู้ดูแล"
    });

    return NextResponse.json(
      {
        event,
        target_count: rawTargets.length
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}
