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

  const textFamily = "Arial,Helvetica,sans-serif";

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

  <!-- ══════════════════════════════════════════════
       ICON 1 — โอนเงิน  (coin circle + ฿)
       ══════════════════════════════════════════════ -->
  <circle cx="${cx1}" cy="100" r="54" fill="#fb7185"/>
  <circle cx="${cx1}" cy="100" r="54" fill="none" stroke="white" stroke-width="2" opacity="0.35"/>
  <!-- ฿ symbol: two thin horizontal lines through a B -->
  <text x="${cx1}" y="120" text-anchor="middle"
        font-size="58" font-weight="900" fill="white"
        font-family="Arial,Helvetica,sans-serif">&#x0E3F;</text>

  <!-- ══════════════════════════════════════════════
       ICON 2 — สถานะ  (circle + 3-bar chart)
       ══════════════════════════════════════════════ -->
  <circle cx="${cx2}" cy="100" r="54" fill="#2dd4bf"/>
  <circle cx="${cx2}" cy="100" r="54" fill="none" stroke="white" stroke-width="2" opacity="0.35"/>
  <!-- Bar chart: short / medium / tall -->
  <rect x="${cx2 - 36}" y="88"  width="18" height="30" rx="4" fill="white"/>
  <rect x="${cx2 - 9}"  y="74"  width="18" height="44" rx="4" fill="white"/>
  <rect x="${cx2 + 18}" y="60"  width="18" height="58" rx="4" fill="white"/>

  <!-- ══════════════════════════════════════════════
       ICON 3 — ติดต่อ  (circle + speech bubble)
       ══════════════════════════════════════════════ -->
  <circle cx="${cx3}" cy="100" r="54" fill="#a855f7"/>
  <circle cx="${cx3}" cy="100" r="54" fill="none" stroke="white" stroke-width="2" opacity="0.35"/>
  <!-- Bubble body -->
  <rect x="${cx3 - 36}" y="68" width="72" height="44" rx="11" fill="white"/>
  <!-- Tail -->
  <path d="M${cx3 - 18},112 L${cx3 - 30},128 L${cx3 + 2},112 Z" fill="white"/>
  <!-- Three dots inside bubble -->
  <circle cx="${cx3 - 18}" cy="90" r="5" fill="#a855f7"/>
  <circle cx="${cx3}"       cy="90" r="5" fill="#a855f7"/>
  <circle cx="${cx3 + 18}"  cy="90" r="5" fill="#a855f7"/>

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
