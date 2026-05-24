import { SARABUN_BOLD_B64, SARABUN_REGULAR_B64 } from "@/lib/fonts";

// ── Font registration ────────────────────────────────────────────────────────
// Register Sarabun (Regular + Bold) into @napi-rs/canvas once per process.
// This avoids librsvg / fontconfig issues on Vercel where no system Thai
// fonts exist.  @napi-rs/canvas has its own bundled text engine.
let _fontsReady = false;
async function ensureFonts() {
  if (_fontsReady) return;
  const { GlobalFonts } = await import("@napi-rs/canvas");
  GlobalFonts.register(
    Buffer.from(SARABUN_REGULAR_B64, "base64"),
    "Sarabun"
  );
  GlobalFonts.register(
    Buffer.from(SARABUN_BOLD_B64, "base64"),
    "Sarabun"
  );
  _fontsReady = true;
}

// ── LINE API types ───────────────────────────────────────────────────────────
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

// ── LINE API helpers ─────────────────────────────────────────────────────────
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

// ── Image generators ─────────────────────────────────────────────────────────

/**
 * Generates a 2500×270 compact Rich Menu image.
 * Three full-bleed colour panels (Coral / Sky-Teal / Violet-Indigo),
 * each with an icon and Thai label text.
 */
export async function generateCompactMenuImage(): Promise<Buffer> {
  await ensureFonts();
  const { createCanvas } = await import("@napi-rs/canvas");

  const W = 2500, H = 270;
  const COL = Math.floor(W / 3); // 833

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // ── Round-rect clip ────────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.roundRect(0, 0, W, H, 32);
  ctx.clip();

  // ── Panel backgrounds ──────────────────────────────────────────────────────
  const panelDefs: [string, string, number, number][] = [
    ["#ff6b6b", "#c0134f", 0,        COL],
    ["#38bdf8", "#0e7490", COL,      COL],
    ["#c084fc", "#4338ca", COL * 2,  W - COL * 2]
  ];
  for (const [top, bot, px, pw] of panelDefs) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, top);
    g.addColorStop(1, bot);
    ctx.fillStyle = g;
    ctx.fillRect(px, 0, pw, H);
  }

  // ── Top sheen ──────────────────────────────────────────────────────────────
  const sheen = ctx.createLinearGradient(0, 0, 0, H);
  sheen.addColorStop(0, "rgba(255,255,255,0.14)");
  sheen.addColorStop(0.45, "rgba(255,255,255,0)");
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, W, H);

  // ── Panel dividers ─────────────────────────────────────────────────────────
  ctx.fillStyle = "rgba(255,255,255,0.2)";
  ctx.fillRect(COL - 1,     0, 2, H);
  ctx.fillRect(COL * 2 - 1, 0, 2, H);

  // ── Icon layout constants ──────────────────────────────────────────────────
  const cx1 = Math.round(COL / 2);            // 417
  const cx2 = Math.round(COL + COL / 2);      // 1250
  const cx3 = Math.round(COL * 2 + COL / 2);  // 2083
  const ICY = 62, ICR = 36;
  const TITLE_Y = 158, SUB_Y = 220;

  const drawHalo = (cx: number) => {
    ctx.beginPath();
    ctx.arc(cx, ICY, ICR, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.45)";
    ctx.lineWidth = 2;
    ctx.stroke();
  };

  // ── Icon 1: ฿ (Baht) ───────────────────────────────────────────────────────
  drawHalo(cx1);
  ctx.font = "900 44px Sarabun";
  ctx.fillStyle = "white";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("฿", cx1, ICY);

  // ── Icon 2: bar chart ──────────────────────────────────────────────────────
  drawHalo(cx2);
  ctx.fillStyle = "white";
  for (const [bx, by, bh] of [
    [cx2 - 27, ICY - 8,  22],
    [cx2 - 7,  ICY - 20, 34],
    [cx2 + 13, ICY - 32, 46]
  ] as [number, number, number][]) {
    ctx.beginPath();
    ctx.roundRect(bx, by, 14, bh, 3);
    ctx.fill();
  }

  // ── Icon 3: speech bubble ──────────────────────────────────────────────────
  drawHalo(cx3);
  ctx.fillStyle = "white";
  ctx.beginPath();
  ctx.roundRect(cx3 - 26, ICY - 16, 52, 32, 8);
  ctx.fill();
  // Tail
  ctx.beginPath();
  ctx.moveTo(cx3 - 10, ICY + 16);
  ctx.lineTo(cx3 - 20, ICY + 30);
  ctx.lineTo(cx3 + 4,  ICY + 16);
  ctx.closePath();
  ctx.fill();
  // Dots
  for (const dotX of [cx3 - 10, cx3, cx3 + 10]) {
    ctx.beginPath();
    ctx.arc(dotX, ICY, 4, 0, Math.PI * 2);
    ctx.fillStyle = "#6d28d9";
    ctx.fill();
  }

  // ── Titles ─────────────────────────────────────────────────────────────────
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "center";
  ctx.fillStyle = "white";
  ctx.font = "bold 84px Sarabun";
  ctx.fillText("โอนเงิน", cx1, TITLE_Y);
  ctx.fillText("สถานะ",   cx2, TITLE_Y);
  ctx.fillText("ติดต่อ",  cx3, TITLE_Y);

  // ── Subtitles ──────────────────────────────────────────────────────────────
  ctx.font = "58px Sarabun";
  ctx.globalAlpha = 0.9;
  ctx.fillText("เลือกงาน / รับ QR Code",   cx1, SUB_Y);
  ctx.fillText("ตรวจสอบการชำระเงิน", cx2, SUB_Y);
  ctx.fillText("สอบถามทีมงาน",         cx3, SUB_Y);
  ctx.globalAlpha = 1;

  return canvas.encodeSync("png");
}

/**
 * Generates a 2500×1686 four-button Rich Menu image.
 * 2×2 grid of frosted-glass cards on a pastel rainbow background,
 * each with a badge circle, Thai title and subtitle.
 */
export async function generateFourButtonMenuImage(): Promise<Buffer> {
  await ensureFonts();
  const { createCanvas } = await import("@napi-rs/canvas");

  const W = 2500, H = 1686;
  const COL = Math.floor(W / 2); // 1250
  const ROW = Math.floor(H / 2); // 843
  const cardW = COL - 124;
  const cardH = ROW - 122;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // ── Rainbow background ─────────────────────────────────────────────────────
  const rainbow = ctx.createLinearGradient(0, 0, W, H);
  rainbow.addColorStop(0,    "#ffe4e6");
  rainbow.addColorStop(0.18, "#fed7aa");
  rainbow.addColorStop(0.36, "#fef3c7");
  rainbow.addColorStop(0.54, "#bbf7d0");
  rainbow.addColorStop(0.72, "#bae6fd");
  rainbow.addColorStop(0.88, "#ddd6fe");
  rainbow.addColorStop(1,    "#fbcfe8");
  ctx.fillStyle = rainbow;
  ctx.fillRect(0, 0, W, H);

  // ── Glow overlays ──────────────────────────────────────────────────────────
  const R = Math.max(W, H);
  const glowA = ctx.createRadialGradient(W * 0.18, H * 0.18, 0, W * 0.18, H * 0.18, R * 0.52);
  glowA.addColorStop(0, "rgba(255,255,255,0.9)");
  glowA.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glowA;
  ctx.fillRect(0, 0, W, H);

  const glowB = ctx.createRadialGradient(W * 0.88, H * 0.78, 0, W * 0.88, H * 0.78, R * 0.58);
  glowB.addColorStop(0, "rgba(255,255,255,0.65)");
  glowB.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glowB;
  ctx.fillRect(0, 0, W, H);

  // ── Decorative wave strokes ────────────────────────────────────────────────
  ctx.lineCap = "round";

  ctx.strokeStyle = "rgba(255,255,255,0.34)";
  ctx.lineWidth = 86;
  ctx.beginPath();
  ctx.moveTo(-120, 500);
  ctx.bezierCurveTo(260, 240,  540, 240,  900, 500);
  ctx.bezierCurveTo(1260, 760, 1530, 750, 1980, 440);
  ctx.bezierCurveTo(2430, 130, 2500, 190, 2680, 390);
  ctx.stroke();

  ctx.strokeStyle = "rgba(255,255,255,0.26)";
  ctx.lineWidth = 62;
  ctx.beginPath();
  ctx.moveTo(-160, 1120);
  ctx.bezierCurveTo(260, 910,  520, 980,  860, 1180);
  ctx.bezierCurveTo(1200, 1380, 1510, 1470, 1940, 1110);
  ctx.bezierCurveTo(2370, 750,  2380, 830,  2680, 1040);
  ctx.stroke();

  // ── Cards ──────────────────────────────────────────────────────────────────
  const items = [
    { x: 76,        y: 74,        title: "สร้าง QR Code", sub: "เลือกงานและชื่อเพื่อจ่ายเงิน", badge: "QR", accent: "#7dd3fc", color: "#1f3b63" },
    { x: COL + 48,  y: 74,        title: "ส่งสลิป",        sub: "อัปโหลดหลักฐานการโอน",         badge: "UP", accent: "#86efac", color: "#14532d" },
    { x: 76,        y: ROW + 48,  title: "สถานะ",           sub: "ดูผลชำระเงินล่าสุด",            badge: "OK", accent: "#c4b5fd", color: "#3b2779" },
    { x: COL + 48,  y: ROW + 48,  title: "ติดต่อ",          sub: "สอบถามผู้ดูแลระบบ",             badge: "Hi", accent: "#f9a8d4", color: "#831843" }
  ];

  for (const item of items) {
    const { x, y, title, sub, badge, accent, color } = item;

    // Card with drop-shadow
    ctx.save();
    ctx.shadowColor   = "rgba(100,116,139,0.20)";
    ctx.shadowBlur    = 44;
    ctx.shadowOffsetY = 24;
    ctx.fillStyle     = "rgba(255,255,255,0.76)";
    ctx.beginPath();
    ctx.roundRect(x, y, cardW, cardH, 64);
    ctx.fill();
    ctx.restore();

    // Card stroke
    ctx.strokeStyle = "white";
    ctx.lineWidth   = 5;
    ctx.beginPath();
    ctx.roundRect(x, y, cardW, cardH, 64);
    ctx.stroke();

    // Accent bar at top of card
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.roundRect(x + 34, y + 34, cardW - 68, 14, 7);
    ctx.fill();

    // Badge outer circle (86 % opacity)
    const bcx = x + 174, bcy = y + 252;
    ctx.globalAlpha = 0.86;
    ctx.fillStyle   = accent;
    ctx.beginPath();
    ctx.arc(bcx, bcy, 116, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Badge inner circle (42 % white)
    ctx.fillStyle = "rgba(255,255,255,0.42)";
    ctx.beginPath();
    ctx.arc(bcx, bcy, 82, 0, Math.PI * 2);
    ctx.fill();

    // Badge label (ASCII, renders without Thai font issues)
    ctx.font         = "900 74px Sarabun";
    ctx.fillStyle    = color;
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(badge, bcx, bcy);

    // Card title (Thai)
    ctx.font         = "900 86px Sarabun";
    ctx.fillStyle    = color;
    ctx.textAlign    = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(title, x + 336, y + 244);

    // Card subtitle (Thai)
    ctx.font      = "bold 46px Sarabun";
    ctx.fillStyle = "#64748b";
    ctx.fillText(sub, x + 340, y + 338);

    // Pill button (bottom of card)
    ctx.globalAlpha = 0.52;
    ctx.fillStyle   = accent;
    ctx.beginPath();
    ctx.roundRect(x + COL - 260, y + ROW - 238, 198, 88, 44);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // ── Grid dividers ──────────────────────────────────────────────────────────
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.beginPath();
  ctx.roundRect(COL - 2, 72, 4, H - 144, 2);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(72, ROW - 2, W - 144, 4, 2);
  ctx.fill();

  return canvas.encodeSync("png");
}
