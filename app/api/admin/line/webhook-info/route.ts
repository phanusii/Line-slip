import { NextRequest, NextResponse } from "next/server";
import { formatApiError } from "@/lib/api-error";
import { assertAdmin } from "@/lib/auth";
import { appBaseUrl } from "@/lib/line";

async function lineRequest(path: string, init?: RequestInit) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error("ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN");

  const response = await fetch(`https://api.line.me${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  return { ok: response.ok, status: response.status, body };
}

export async function GET(request: NextRequest) {
  try {
    assertAdmin(request);
    const expectedEndpoint = `${appBaseUrl()}/api/line/webhook`;
    const endpoint = await lineRequest("/v2/bot/channel/webhook/endpoint");
    const test = await lineRequest("/v2/bot/channel/webhook/test", { method: "POST" });

    return NextResponse.json({
      expectedEndpoint,
      endpoint,
      test,
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: formatApiError(error) }, { status: 500 });
  }
}
