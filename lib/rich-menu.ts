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

// Generates a 2500x270 compact Rich Menu image.
// Design: "Vivid Panels" — 3 full-bleed colour panels (Coral / Sky-Teal / Violet-Indigo)
// clipped to a rounded rectangle. Each panel: SVG icon + bold title + subtitle text.
export async function generateCompactMenuImage(): Promise<Buffer> {
  const sharp = (await import("sharp")).default;

  const W   = 2500;
  const H   = 270;
  const COL = Math.floor(W / 3); // 833

  const cx1 = Math.round(COL / 2);            // 417
  const cx2 = Math.round(COL + COL / 2);      // 1250
  const cx3 = Math.round(COL * 2 + COL / 2);  // 2083

  // Vertical rhythm: icon centre → title → subtitle
  // Font sizes must be large enough to remain legible when the
  // 2500×270 image is scaled down to ~42 logical-px height on phone.
  const ICY    = 62;   // icon circle centre-y (smaller → more room for text)
  const ICR    = 36;   // icon circle radius
  const TITLE_Y = 158; // bold label baseline  (font 84 px → ~13 px on screen)
  const SUB_Y   = 220; // subtitle baseline    (font 58 px → ~9 px on screen)

  const F = "Arial,Helvetica,sans-serif";

  // ── Thai text as Unicode escapes (librsvg-safe) ──────────────────────────
  // Titles
  const T_TRANSFER = "&#x0E42;&#x0E2D;&#x0E19;&#x0E40;&#x0E07;&#x0E34;&#x0E19;"; // โอนเงิน
  const T_STATUS   = "&#x0E2A;&#x0E16;&#x0E32;&#x0E19;&#x0E30;";                  // สถานะ
  const T_CONTACT  = "&#x0E15;&#x0E34;&#x0E14;&#x0E15;&#x0E48;&#x0E2D;";          // ติดต่อ
  // Subtitles
  // "เลือกงาน / รับ QR Code"
  const S_TRANSFER = "&#x0E40;&#x0E25;&#x0E37;&#x0E2D;&#x0E01;&#x0E07;&#x0E32;&#x0E19; / &#x0E23;&#x0E31;&#x0E1A; QR Code";
  // "ตรวจสอบการชำระเงิน"
  const S_STATUS   = "&#x0E15;&#x0E23;&#x0E27;&#x0E08;&#x0E2A;&#x0E2D;&#x0E1A;&#x0E01;&#x0E32;&#x0E23;&#x0E0A;&#x0E33;&#x0E23;&#x0E30;&#x0E40;&#x0E07;&#x0E34;&#x0E19;";
  // "สอบถามทีมงาน"
  const S_CONTACT  = "&#x0E2A;&#x0E2D;&#x0E1A;&#x0E16;&#x0E32;&#x0E21;&#x0E17;&#x0E35;&#x0E21;&#x0E07;&#x0E32;&#x0E19;";

  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <clipPath id="card"><rect width="${W}" height="${H}" rx="32"/></clipPath>

    <!-- Panel 1: Coral → Crimson -->
    <linearGradient id="g1" x1="0" y1="0" x2="0" y2="${H}" gradientUnits="userSpaceOnUse">
      <stop offset="0%"   stop-color="#ff6b6b"/>
      <stop offset="100%" stop-color="#c0134f"/>
    </linearGradient>
    <!-- Panel 2: Sky → Teal -->
    <linearGradient id="g2" x1="0" y1="0" x2="0" y2="${H}" gradientUnits="userSpaceOnUse">
      <stop offset="0%"   stop-color="#38bdf8"/>
      <stop offset="100%" stop-color="#0e7490"/>
    </linearGradient>
    <!-- Panel 3: Violet → Indigo -->
    <linearGradient id="g3" x1="0" y1="0" x2="0" y2="${H}" gradientUnits="userSpaceOnUse">
      <stop offset="0%"   stop-color="#c084fc"/>
      <stop offset="100%" stop-color="#4338ca"/>
    </linearGradient>
    <!-- Shared top-sheen -->
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="${H}" gradientUnits="userSpaceOnUse">
      <stop offset="0%"  stop-color="white" stop-opacity="0.14"/>
      <stop offset="45%" stop-color="white" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <g clip-path="url(#card)">

    <!-- ── Three full-bleed colour panels ── -->
    <rect x="0"          y="0" width="${COL}"       height="${H}" fill="url(#g1)"/>
    <rect x="${COL}"     y="0" width="${COL}"       height="${H}" fill="url(#g2)"/>
    <rect x="${COL * 2}" y="0" width="${W - COL*2}" height="${H}" fill="url(#g3)"/>
    <rect x="0" y="0" width="${W}" height="${H}" fill="url(#sheen)"/>

    <!-- ── Panel dividers ── -->
    <rect x="${COL - 1}"     y="0" width="2" height="${H}" fill="white" opacity="0.2"/>
    <rect x="${COL * 2 - 1}" y="0" width="2" height="${H}" fill="white" opacity="0.2"/>

    <!-- ══════════════════════════════════════════
         ICON 1 — โอนเงิน  (฿ in halo)
         ══════════════════════════════════════════ -->
    <circle cx="${cx1}" cy="${ICY}" r="${ICR}" fill="white" opacity="0.18"/>
    <circle cx="${cx1}" cy="${ICY}" r="${ICR}" fill="none" stroke="white" stroke-width="2" opacity="0.45"/>
    <text x="${cx1}" y="${ICY + 14}" text-anchor="middle"
          font-size="44" font-weight="900" fill="white" font-family="${F}">&#x0E3F;</text>

    <!-- ══════════════════════════════════════════
         ICON 2 — สถานะ  (3-bar chart)
         ══════════════════════════════════════════ -->
    <circle cx="${cx2}" cy="${ICY}" r="${ICR}" fill="white" opacity="0.18"/>
    <circle cx="${cx2}" cy="${ICY}" r="${ICR}" fill="none" stroke="white" stroke-width="2" opacity="0.45"/>
    <!-- bars bottom-aligned at ICY+14, heights 22/34/46 -->
    <rect x="${cx2 - 27}" y="${ICY - 8}"  width="14" height="22" rx="3" fill="white"/>
    <rect x="${cx2 - 7}"  y="${ICY - 20}" width="14" height="34" rx="3" fill="white"/>
    <rect x="${cx2 + 13}" y="${ICY - 32}" width="14" height="46" rx="3" fill="white"/>

    <!-- ══════════════════════════════════════════
         ICON 3 — ติดต่อ  (speech bubble)
         ══════════════════════════════════════════ -->
    <circle cx="${cx3}" cy="${ICY}" r="${ICR}" fill="white" opacity="0.18"/>
    <circle cx="${cx3}" cy="${ICY}" r="${ICR}" fill="none" stroke="white" stroke-width="2" opacity="0.45"/>
    <!-- bubble fits inside circle (cy=62, r=36 → y: 26–98) -->
    <rect x="${cx3 - 26}" y="${ICY - 16}" width="52" height="32" rx="8" fill="white"/>
    <path d="M${cx3 - 10},${ICY + 16} L${cx3 - 20},${ICY + 30} L${cx3 + 4},${ICY + 16} Z" fill="white"/>
    <circle cx="${cx3 - 10}" cy="${ICY}"      r="4" fill="#6d28d9"/>
    <circle cx="${cx3}"       cy="${ICY}"      r="4" fill="#6d28d9"/>
    <circle cx="${cx3 + 10}"  cy="${ICY}"      r="4" fill="#6d28d9"/>

    <!-- ── Main titles ── -->
    <text x="${cx1}" y="${TITLE_Y}" text-anchor="middle" font-size="84" font-weight="bold" fill="white" font-family="${F}">${T_TRANSFER}</text>
    <text x="${cx2}" y="${TITLE_Y}" text-anchor="middle" font-size="84" font-weight="bold" fill="white" font-family="${F}">${T_STATUS}</text>
    <text x="${cx3}" y="${TITLE_Y}" text-anchor="middle" font-size="84" font-weight="bold" fill="white" font-family="${F}">${T_CONTACT}</text>

    <!-- ── Subtitles ── -->
    <text x="${cx1}" y="${SUB_Y}" text-anchor="middle" font-size="58" fill="white" opacity="0.9" font-family="${F}">${S_TRANSFER}</text>
    <text x="${cx2}" y="${SUB_Y}" text-anchor="middle" font-size="58" fill="white" opacity="0.9" font-family="${F}">${S_STATUS}</text>
    <text x="${cx3}" y="${SUB_Y}" text-anchor="middle" font-size="58" fill="white" opacity="0.9" font-family="${F}">${S_CONTACT}</text>

  </g>
</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}
