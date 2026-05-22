export type RichMenuAction =
  | { type: "uri"; label?: string; uri: string }
  | { type: "message"; label?: string; text: string }
  | { type: "postback"; label?: string; data: string; displayText?: string };

export type RichMenuArea = {
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  action: RichMenuAction;
};

type CreateRichMenuPayload = {
  size: {
    width: number;
    height: number;
  };
  selected: boolean;
  name: string;
  chatBarText: string;
  areas: RichMenuArea[];
};

async function lineFetch(
  path: string,
  init: RequestInit = {},
  baseUrl = "https://api.line.me"
) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error("ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN");

  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.headers ?? {})
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `LINE API error ${response.status}`);
  }

  return response;
}

export async function createRichMenu(payload: CreateRichMenuPayload) {
  const response = await lineFetch("/v2/bot/richmenu", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  return response.json() as Promise<{ richMenuId: string }>;
}

export async function uploadRichMenuImage(
  richMenuId: string,
  image: Buffer,
  contentType: "image/png" | "image/jpeg"
) {
  await lineFetch(`/v2/bot/richmenu/${richMenuId}/content`, {
    method: "POST",
    headers: {
      "content-type": contentType
    },
    body: image as unknown as BodyInit
  }, "https://api-data.line.me");
}

export async function setDefaultRichMenu(richMenuId: string) {
  await lineFetch(`/v2/bot/user/all/richmenu/${richMenuId}`, {
    method: "POST"
  });
}

export async function deleteRichMenu(richMenuId: string) {
  await lineFetch(`/v2/bot/richmenu/${richMenuId}`, {
    method: "DELETE"
  });
}

export async function listRichMenus(): Promise<{ richmenus: Array<{ richMenuId: string }> }> {
  const response = await lineFetch("/v2/bot/richmenu/list");
  return response.json() as Promise<{ richmenus: Array<{ richMenuId: string }> }>;
}

// Generates a 2500x270 compact Rich Menu image with 3 colored sections.
// Uses SVG rendered via sharp — no font file needed.
export async function generateCompactMenuImage(): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const svg = `<svg width="2500" height="270" xmlns="http://www.w3.org/2000/svg">
    <rect x="0"    y="0" width="833"  height="270" fill="#16a34a"/>
    <rect x="835"  y="0" width="832"  height="270" fill="#2563eb"/>
    <rect x="1669" y="0" width="831"  height="270" fill="#ea580c"/>
    <rect x="833"  y="0" width="2"    height="270" fill="#ffffff" opacity="0.4"/>
    <rect x="1667" y="0" width="2"    height="270" fill="#ffffff" opacity="0.4"/>
    <circle cx="416"  cy="100" r="52" fill="rgba(255,255,255,0.18)"/>
    <circle cx="1250" cy="100" r="52" fill="rgba(255,255,255,0.18)"/>
    <circle cx="2083" cy="100" r="52" fill="rgba(255,255,255,0.18)"/>
    <text x="416"  y="123" text-anchor="middle" font-size="64" font-family="Segoe UI Emoji,Apple Color Emoji,Noto Color Emoji,sans-serif">💸</text>
    <text x="1250" y="123" text-anchor="middle" font-size="64" font-family="Segoe UI Emoji,Apple Color Emoji,Noto Color Emoji,sans-serif">📋</text>
    <text x="2083" y="123" text-anchor="middle" font-size="64" font-family="Segoe UI Emoji,Apple Color Emoji,Noto Color Emoji,sans-serif">📞</text>
    <text x="416"  y="210" text-anchor="middle" font-size="52" font-weight="bold" fill="white" font-family="sans-serif">&#x0E42;&#x0E2D;&#x0E19;&#x0E40;&#x0E07;&#x0E34;&#x0E19;</text>
    <text x="1250" y="210" text-anchor="middle" font-size="52" font-weight="bold" fill="white" font-family="sans-serif">&#x0E2A;&#x0E16;&#x0E32;&#x0E19;&#x0E30;</text>
    <text x="2083" y="210" text-anchor="middle" font-size="52" font-weight="bold" fill="white" font-family="sans-serif">&#x0E15;&#x0E34;&#x0E14;&#x0E15;&#x0E48;&#x0E2D;</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
