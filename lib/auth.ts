import { NextRequest } from "next/server";

export function assertAdmin(request: NextRequest) {
  const configured = process.env.ADMIN_SHARED_SECRET;

  if (!configured || configured === "change-me") {
    throw new Response(
      JSON.stringify({
        error: "Set ADMIN_SHARED_SECRET before using admin APIs."
      }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }

  const provided = request.headers.get("x-admin-secret");
  if (provided !== configured) {
    throw new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" }
    });
  }
}

export function actorFromRequest(request: NextRequest) {
  return {
    actor_email: request.headers.get("x-admin-email") ?? "local-admin",
    actor_role: "admin" as const
  };
}
