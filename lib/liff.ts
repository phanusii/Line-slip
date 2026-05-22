type LineTokenInfo = {
  client_id: string;
  expires_in: number;
  scope: string;
};

export type LineProfile = {
  userId: string;
  displayName?: string;
  pictureUrl?: string;
};

export function getBearerToken(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const [scheme, token] = header.split(/\s+/, 2);

  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }

  return token;
}

export async function requireLineAccessToken(request: Request) {
  const accessToken = getBearerToken(request);

  if (!accessToken) {
    throw new Response(
      JSON.stringify({ error: "กรุณาเปิดผ่าน LINE LIFF เพื่อดูข้อมูลงาน" }),
      {
        status: 401,
        headers: { "content-type": "application/json" }
      }
    );
  }

  await verifyLineAccessToken(accessToken);
  return accessToken;
}

export async function verifyLineAccessToken(accessToken: string) {
  const response = await fetch(
    `https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(accessToken)}`
  );

  if (!response.ok) {
    throw new Error("LINE access token หมดอายุ กรุณาเปิด LIFF ใหม่อีกครั้ง");
  }

  const tokenInfo = (await response.json()) as LineTokenInfo;
  const expectedChannelId = process.env.LINE_LIFF_CHANNEL_ID;
  if (expectedChannelId && tokenInfo.client_id !== expectedChannelId) {
    throw new Error("LIFF channel ไม่ตรงกับระบบนี้");
  }

  return tokenInfo;
}

export async function getLineProfile(accessToken: string) {
  const response = await fetch("https://api.line.me/v2/profile", {
    headers: {
      authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    throw new Error("ยืนยันตัวตน LINE ไม่สำเร็จ กรุณาเปิดผ่าน LIFF ใน LINE อีกครั้ง");
  }

  return response.json() as Promise<LineProfile>;
}
