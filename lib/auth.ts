import { NextRequest } from "next/server";

type Role = "admin" | "viewer";

export function assertAdmin(request: NextRequest, requiredRole: Role = "admin") {
  const adminSecret = process.env.ADMIN_SHARED_SECRET;
  const viewerSecret = process.env.VIEWER_SHARED_SECRET;
  const provided = request.headers.get("x-admin-secret");

  if (!adminSecret || adminSecret === "change-me") {
    throw new Response(
      JSON.stringify({
        error: "กรุณาตั้งค่า ADMIN_SHARED_SECRET ก่อนใช้งาน API ผู้ดูแล"
      }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }

  const isAdmin = provided === adminSecret;
  const isViewer = Boolean(viewerSecret && provided === viewerSecret);

  if (!isAdmin && !isViewer) {
    throw new Response(JSON.stringify({ error: "รหัสผู้ดูแลไม่ถูกต้อง" }), {
      status: 401,
      headers: { "content-type": "application/json" }
    });
  }

  if (requiredRole === "admin" && !isAdmin) {
    throw new Response(JSON.stringify({ error: "บัญชีนี้ไม่มีสิทธิ์แก้ไขหรือลบข้อมูล" }), {
      status: 403,
      headers: { "content-type": "application/json" }
    });
  }
}

export function actorFromRequest(request: NextRequest) {
  const provided = request.headers.get("x-admin-secret");
  const isViewer = Boolean(process.env.VIEWER_SHARED_SECRET && provided === process.env.VIEWER_SHARED_SECRET);

  return {
    actor_email: request.headers.get("x-admin-email") ?? (isViewer ? "viewer" : "local-admin"),
    actor_role: isViewer ? ("viewer" as const) : ("admin" as const)
  };
}
