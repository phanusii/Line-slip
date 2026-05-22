"use client";

import { ImageUp, Send } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type AreaActionKind = "pay" | "me" | "custom_url" | "message" | "none";

type TemplateId = "single" | "two" | "three" | "six";

type AreaConfig = {
  kind: AreaActionKind;
  label: string;
  uri: string;
  text: string;
};

type TemplateArea = {
  key: string;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
};

const templates: Array<{ id: TemplateId; label: string }> = [
  { id: "single", label: "1 ช่อง" },
  { id: "two", label: "2 ช่อง" },
  { id: "three", label: "3 ช่อง" },
  { id: "six", label: "6 ช่อง" }
];

function templateAreas(template: TemplateId, height: number): TemplateArea[] {
  if (template === "single") {
    return [{ key: "A", label: "A", bounds: { x: 0, y: 0, width: 2500, height } }];
  }

  if (template === "two") {
    return [
      { key: "A", label: "A", bounds: { x: 0, y: 0, width: 1250, height } },
      { key: "B", label: "B", bounds: { x: 1250, y: 0, width: 1250, height } }
    ];
  }

  if (template === "three") {
    return [
      { key: "A", label: "A", bounds: { x: 0, y: 0, width: 834, height } },
      { key: "B", label: "B", bounds: { x: 834, y: 0, width: 833, height } },
      { key: "C", label: "C", bounds: { x: 1667, y: 0, width: 833, height } }
    ];
  }

  const rowHeight = Math.floor(height / 2);
  return [
    { key: "A", label: "A", bounds: { x: 0, y: 0, width: 834, height: rowHeight } },
    { key: "B", label: "B", bounds: { x: 834, y: 0, width: 833, height: rowHeight } },
    { key: "C", label: "C", bounds: { x: 1667, y: 0, width: 833, height: rowHeight } },
    { key: "D", label: "D", bounds: { x: 0, y: rowHeight, width: 834, height: height - rowHeight } },
    { key: "E", label: "E", bounds: { x: 834, y: rowHeight, width: 833, height: height - rowHeight } },
    { key: "F", label: "F", bounds: { x: 1667, y: rowHeight, width: 833, height: height - rowHeight } }
  ];
}

function defaultConfig(index: number, payUrl: string, meUrl: string): AreaConfig {
  if (index === 0) {
    return { kind: "pay", label: "เลือกงาน", uri: payUrl, text: "เลือกงาน" };
  }

  if (index === 1) {
    return { kind: "me", label: "ข้อมูลของฉัน", uri: meUrl, text: "ข้อมูลของฉัน" };
  }

  return { kind: "none", label: "", uri: "", text: "" };
}

function buildAction(config: AreaConfig, payUrl: string, meUrl: string) {
  if (config.kind === "none") return null;
  if (config.kind === "pay") return { type: "uri", label: config.label || "เลือกงาน", uri: payUrl };
  if (config.kind === "me") return { type: "uri", label: config.label || "ข้อมูลของฉัน", uri: meUrl };
  if (config.kind === "message") return { type: "message", label: config.label || config.text, text: config.text };
  return { type: "uri", label: config.label || "เปิดลิงก์", uri: config.uri };
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("อ่านไฟล์รูปไม่สำเร็จ"));
    reader.readAsDataURL(file);
  });
}

type RichMenuBuilderProps = {
  isAuthenticated: boolean;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  setError: (error: string | null) => void;
  origin: string;
};

export function RichMenuBuilder({
  isAuthenticated,
  busy,
  setBusy,
  setError,
  origin
}: RichMenuBuilderProps) {
  const liffId = process.env.NEXT_PUBLIC_LIFF_ID ?? "";
  const payUrl = liffId ? `https://liff.line.me/${liffId}` : `${origin}/liff`;
  const meUrl = liffId ? `https://liff.line.me/${liffId}?page=me` : `${origin}/liff?page=me`;
  const [name, setName] = useState("เมนูชำระเงิน");
  const [chatBarText, setChatBarText] = useState("เมนู");
  const [height, setHeight] = useState(843);
  const [template, setTemplate] = useState<TemplateId>("two");
  const [activeAreaKey, setActiveAreaKey] = useState("A");
  const [imageDataUrl, setImageDataUrl] = useState("");
  const [configs, setConfigs] = useState<AreaConfig[]>([]);
  const [publishedId, setPublishedId] = useState("");

  const areas = useMemo(() => templateAreas(template, height), [template, height]);
  const activeIndex = Math.max(0, areas.findIndex((area) => area.key === activeAreaKey));
  const activeConfig = configs[activeIndex] ?? defaultConfig(activeIndex, payUrl, meUrl);

  useEffect(() => {
    setConfigs((current) =>
      areas.map((_, index) => current[index] ?? defaultConfig(index, payUrl, meUrl))
    );
    if (!areas.some((area) => area.key === activeAreaKey)) {
      setActiveAreaKey(areas[0]?.key ?? "A");
    }
  }, [areas, activeAreaKey, payUrl, meUrl]);

  function updateActiveConfig(patch: Partial<AreaConfig>) {
    setConfigs((current) =>
      areas.map((_, index) =>
        index === activeIndex
          ? { ...(current[index] ?? defaultConfig(index, payUrl, meUrl)), ...patch }
          : current[index] ?? defaultConfig(index, payUrl, meUrl)
      )
    );
  }

  async function onImageChange(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (!["image/png", "image/jpeg"].includes(file.type)) {
      setError("รองรับเฉพาะรูป PNG หรือ JPEG");
      return;
    }

    if (file.size > 1024 * 1024) {
      setError("รูป Rich Menu ต้องไม่เกิน 1 MB");
      return;
    }

    try {
      setImageDataUrl(await readFileAsDataUrl(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function publishRichMenu() {
    if (!imageDataUrl) {
      setError("กรุณาอัปโหลดรูป Rich Menu ก่อน");
      return;
    }

    const activeAreas = areas
      .map((area, index) => {
        const action = buildAction(
          configs[index] ?? defaultConfig(index, payUrl, meUrl),
          payUrl,
          meUrl
        );
        return action ? { bounds: area.bounds, action } : null;
      })
      .filter(Boolean);

    if (!activeAreas.length) {
      setError("กรุณาตั้ง Action อย่างน้อย 1 ช่อง");
      return;
    }

    setBusy(true);
    setError(null);
    setPublishedId("");
    try {
      const response = await fetch("/api/admin/rich-menu/publish", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          name,
          chatBarText,
          width: 2500,
          height,
          imageDataUrl,
          areas: activeAreas,
          setDefault: true
        })
      });
      const data = (await response.json()) as { richMenuId?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? "สร้าง Rich Menu ไม่สำเร็จ");
      setPublishedId(data.richMenuId ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel richMenuBuilder">
      <div className="panelHeader">
        <div>
          <h2>ตั้งค่า Rich Menu</h2>
          <p className="muted">อัปโหลดรูป เลือกช่อง ตั้ง Action แล้วเผยแพร่เป็นเมนูหลักใน LINE</p>
        </div>
        {publishedId ? <span className="badge ok">เผยแพร่แล้ว</span> : <span className="badge">LINE API</span>}
      </div>

      <div className="richMenuGrid">
        <div className="richPreviewPanel">
          <div
            className="richPreview"
            style={{ aspectRatio: `2500 / ${height}` }}
          >
            {imageDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={imageDataUrl} alt="ตัวอย่าง Rich Menu" />
            ) : (
              <div className="richEmpty">
                <ImageUp size={28} />
                <span>อัปโหลดรูปขนาด 2500x{height}px</span>
              </div>
            )}
            {areas.map((area) => (
              <button
                className={activeAreaKey === area.key ? "richArea active" : "richArea"}
                key={area.key}
                onClick={() => setActiveAreaKey(area.key)}
                style={{
                  left: `${(area.bounds.x / 2500) * 100}%`,
                  top: `${(area.bounds.y / height) * 100}%`,
                  width: `${(area.bounds.width / 2500) * 100}%`,
                  height: `${(area.bounds.height / height) * 100}%`
                }}
              >
                {area.label}
              </button>
            ))}
          </div>
          <label className="uploadButton">
            <input type="file" accept="image/png,image/jpeg" onChange={(event) => onImageChange(event.target.files?.[0])} />
            <ImageUp size={16} />
            อัปโหลดรูป Rich Menu
          </label>
        </div>

        <div className="richControls">
          <div className="formGrid">
            <label className="field">
              <span>ชื่อเมนู</span>
              <input value={name} maxLength={30} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="field">
              <span>ข้อความบนแถบเมนู</span>
              <input value={chatBarText} maxLength={14} onChange={(event) => setChatBarText(event.target.value)} />
            </label>
          </div>

          <div className="formGrid">
            <label className="field">
              <span>ขนาด</span>
              <select value={height} onChange={(event) => setHeight(Number(event.target.value))}>
                <option value={843}>เล็ก 2500x843</option>
                <option value={1686}>ใหญ่ 2500x1686</option>
              </select>
            </label>
            <label className="field">
              <span>เทมเพลต</span>
              <select value={template} onChange={(event) => setTemplate(event.target.value as TemplateId)}>
                {templates.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="areaEditor">
            <span className="badge">ช่อง {areas[activeIndex]?.label ?? "A"}</span>
            <label className="field">
              <span>Action</span>
              <select
                value={activeConfig.kind}
                onChange={(event) => updateActiveConfig({ kind: event.target.value as AreaActionKind })}
              >
                <option value="pay">เลือกงาน/รับ QR</option>
                <option value="me">เช็คข้อมูลของฉัน</option>
                <option value="custom_url">เปิดลิงก์กำหนดเอง</option>
                <option value="message">ส่งข้อความในแชท</option>
                <option value="none">ไม่ใส่ Action</option>
              </select>
            </label>
            <label className="field">
              <span>ป้าย Action</span>
              <input
                value={activeConfig.label}
                onChange={(event) => updateActiveConfig({ label: event.target.value })}
                placeholder="เช่น เลือกงาน"
              />
            </label>
            {activeConfig.kind === "custom_url" ? (
              <label className="field">
                <span>URL</span>
                <input
                  value={activeConfig.uri}
                  onChange={(event) => updateActiveConfig({ uri: event.target.value })}
                  placeholder="https://example.com"
                />
              </label>
            ) : null}
            {activeConfig.kind === "message" ? (
              <label className="field">
                <span>ข้อความ</span>
                <input
                  value={activeConfig.text}
                  onChange={(event) => updateActiveConfig({ text: event.target.value })}
                  placeholder="เช่น ติดต่อแอดมิน"
                />
              </label>
            ) : null}
            <div className="hintBox">
              <strong>ลิงก์ระบบ</strong>
              <p>เลือกงาน: {payUrl}</p>
              <p>ข้อมูลของฉัน: {meUrl}</p>
            </div>
          </div>

          <button className="btn primary" disabled={!isAuthenticated || busy} onClick={publishRichMenu}>
            <Send size={16} />
            {busy ? "กำลังเผยแพร่" : "เผยแพร่ Rich Menu"}
          </button>
        </div>
      </div>

      {publishedId ? <p className="muted">Rich Menu ID: {publishedId}</p> : null}
    </section>
  );
}
