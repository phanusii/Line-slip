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

// Generates a 2500x270 compact Rich Menu image — dark gradient bg + 3 coloured pill cards.
// Design: "Midnight Bloom" — navy bg · rose/teal/violet pills · rainbow top bar.
export async function generateCompactMenuImage(): Promise<Buffer> {
  const sharp = (await import("sharp")).default;

  const W = 2500;
  const H = 270;
  const COL = Math.floor(W / 3); // 833

  // Pill card geometry (inset 50px from column edges, 18px top/bottom margin)
  const CARD_MX = 50;   // horizontal margin inside each column
  const CARD_MY = 18;
  const CARD_W  = COL - CARD_MX * 2;   // 733
  const CARD_H  = H - CARD_MY * 2;     // 234
  const CARD_RX = 36;

  const cx1 = COL / 2;               // 416
  const cx2 = COL + COL / 2;         // 1250
  const cx3 = COL * 2 + COL / 2;     // 2083
  const iconY = 115;
  const labelY = 222;

  const emojiFamily = "Segoe UI Emoji,Apple Color Emoji,Noto Color Emoji,sans-serif";
  const textFamily  = "Arial,Helvetica,sans-serif";

  // Thai Unicode
  const T_TRANSFER = "&#x0E42;&#x0E2D;&#x0E19;&#x0E40;&#x0E07;&#x0E34;&#x0E19;"; // โอนเงิน
  const T_STATUS   = "&#x0E2A;&#x0E16;&#x0E32;&#x0E19;&#x0E30;";                  // สถานะ
  const T_CONTACT  = "&#x0E15;&#x0E34;&#x0E14;&#x0E15;&#x0E48;&#x0E2D;";          // ติดต่อ

  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <!-- Background -->
    <linearGradient id="bg" x1="0" y1="0" x2="${W}" y2="${H}" gradientUnits="userSpaceOnUse">
      <stop offset="0%"   stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#1e1b4b"/>
    </linearGradient>

    <!-- Top rainbow bar -->
    <linearGradient id="topBar" x1="0" y1="0" x2="${W}" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0%"   stop-color="#f43f8e"/>
      <stop offset="33%"  stop-color="#a855f7"/>
      <stop offset="66%"  stop-color="#22d3ee"/>
      <stop offset="100%" stop-color="#818cf8"/>
    </linearGradient>

    <!-- Pill 1: rose/pink (vertical) -->
    <linearGradient id="pill1" x1="${CARD_MX}" y1="${CARD_MY}" x2="${CARD_MX}" y2="${H - CARD_MY}" gradientUnits="userSpaceOnUse">
      <stop offset="0%"   stop-color="#fb7185"/>
      <stop offset="100%" stop-color="#be123c"/>
    </linearGradient>

    <!-- Pill 2: teal/emerald -->
    <linearGradient id="pill2" x1="${COL + CARD_MX}" y1="${CARD_MY}" x2="${COL + CARD_MX}" y2="${H - CARD_MY}" gradientUnits="userSpaceOnUse">
      <stop offset="0%"   stop-color="#2dd4bf"/>
      <stop offset="100%" stop-color="#0d9488"/>
    </linearGradient>

    <!-- Pill 3: violet/purple -->
    <linearGradient id="pill3" x1="${COL * 2 + CARD_MX}" y1="${CARD_MY}" x2="${COL * 2 + CARD_MX}" y2="${H - CARD_MY}" gradientUnits="userSpaceOnUse">
      <stop offset="0%"   stop-color="#c084fc"/>
      <stop offset="100%" stop-color="#7c3aed"/>
    </linearGradient>
  </defs>

  <!-- ── Background ── -->
  <rect width="${W}" height="${H}" fill="url(#bg)"/>

  <!-- ── Rainbow top accent bar ── -->
  <rect x="0" y="0" width="${W}" height="5" fill="url(#topBar)"/>

  <!-- ── Pill card 1 (rose) ── -->
  <rect x="${CARD_MX}" y="${CARD_MY}" width="${CARD_W}" height="${CARD_H}" rx="${CARD_RX}" fill="url(#pill1)" opacity="0.22"/>
  <rect x="${CARD_MX}" y="${CARD_MY}" width="${CARD_W}" height="${CARD_H}" rx="${CARD_RX}" fill="none" stroke="#fb7185" stroke-width="1.5" opacity="0.55"/>

  <!-- ── Pill card 2 (teal) ── -->
  <rect x="${COL + CARD_MX}" y="${CARD_MY}" width="${CARD_W}" height="${CARD_H}" rx="${CARD_RX}" fill="url(#pill2)" opacity="0.22"/>
  <rect x="${COL + CARD_MX}" y="${CARD_MY}" width="${CARD_W}" height="${CARD_H}" rx="${CARD_RX}" fill="none" stroke="#2dd4bf" stroke-width="1.5" opacity="0.55"/>

  <!-- ── Pill card 3 (violet) ── -->
  <rect x="${COL * 2 + CARD_MX}" y="${CARD_MY}" width="${CARD_W}" height="${CARD_H}" rx="${CARD_RX}" fill="url(#pill3)" opacity="0.22"/>
  <rect x="${COL * 2 + CARD_MX}" y="${CARD_MY}" width="${CARD_W}" height="${CARD_H}" rx="${CARD_RX}" fill="none" stroke="#c084fc" stroke-width="1.5" opacity="0.55"/>

  <!-- ── Glow halos behind icons ── -->
  <circle cx="${cx1}" cy="${iconY - 8}" r="52" fill="#f43f8e" opacity="0.18"/>
  <circle cx="${cx2}" cy="${iconY - 8}" r="52" fill="#2dd4bf" opacity="0.18"/>
  <circle cx="${cx3}" cy="${iconY - 8}" r="52" fill="#c084fc" opacity="0.18"/>

  <!-- ── Emoji icons ── -->
  <text x="${cx1}" y="${iconY}" text-anchor="middle" font-size="72" font-family="${emojiFamily}">💸</text>
  <text x="${cx2}" y="${iconY}" text-anchor="middle" font-size="72" font-family="${emojiFamily}">📊</text>
  <text x="${cx3}" y="${iconY}" text-anchor="middle" font-size="72" font-family="${emojiFamily}">💬</text>

  <!-- ── Thai labels ── -->
  <text x="${cx1}" y="${labelY}" text-anchor="middle" font-size="50" font-weight="bold" fill="white" font-family="${textFamily}">${T_TRANSFER}</text>
  <text x="${cx2}" y="${labelY}" text-anchor="middle" font-size="50" font-weight="bold" fill="white" font-family="${textFamily}">${T_STATUS}</text>
  <text x="${cx3}" y="${labelY}" text-anchor="middle" font-size="50" font-weight="bold" fill="white" font-family="${textFamily}">${T_CONTACT}</text>

  <!-- ── Subtle column dividers ── -->
  <line x1="${COL}" y1="30" x2="${COL}" y2="${H - 30}" stroke="white" stroke-width="1" opacity="0.12"/>
  <line x1="${COL * 2}" y1="30" x2="${COL * 2}" y2="${H - 30}" stroke="white" stroke-width="1" opacity="0.12"/>
</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}
