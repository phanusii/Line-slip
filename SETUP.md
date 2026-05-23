# คู่มือ Deploy ระบบ Line-slip

## ภาพรวมขั้นตอน

```
1. Supabase  →  2. LINE Developers  →  3. Vercel  →  4. Admin Account  →  5. Rich Menu  →  6. แจ้งเตือน
```

---

## 1. ตั้งค่า Supabase

### 1.1 สร้าง Project

1. เข้า [supabase.com](https://supabase.com) → New project
2. ตั้งชื่อ, เลือก region ใกล้ไทย (Singapore), ตั้ง database password (เก็บไว้)

### 1.2 รัน Schema

1. เข้า **SQL Editor** ใน Supabase dashboard
2. วางเนื้อหาทั้งหมดจากไฟล์ `supabase/schema.sql` แล้วกด **Run**
3. ตรวจว่าสร้างตารางสำเร็จ: เข้า **Table Editor** จะเห็น `events`, `payment_targets`, `slip_submissions` เป็นต้น
4. ตรวจ Storage: เข้า **Storage** จะเห็น bucket ชื่อ `slips` (private)

### 1.3 เก็บค่าที่ต้องใช้

เข้า **Settings → API**:
- `Project URL` → ใช้เป็น `NEXT_PUBLIC_SUPABASE_URL`
- `service_role` key (อย่าใช้ anon key) → ใช้เป็น `SUPABASE_SERVICE_ROLE_KEY`

---

## 2. ตั้งค่า LINE Developers

### 2.1 สร้าง Provider และ Channel

1. เข้า [developers.line.biz](https://developers.line.biz) → Create a Provider
2. สร้าง **Messaging API** channel
3. เก็บ:
   - **Channel secret** (Basic settings) → `LINE_CHANNEL_SECRET`
   - **Channel access token** (Messaging API → Issue) → `LINE_CHANNEL_ACCESS_TOKEN`
   - **Channel ID** (Basic settings) → `LINE_LIFF_CHANNEL_ID`

### 2.2 สร้าง LIFF App

1. ไปที่ channel → tab **LIFF** → Add
2. ตั้งค่า:
   - Size: **Full**
   - Endpoint URL: `https://YOUR_DOMAIN/liff`
   - Scopes: เปิด `profile` และ `openid`
3. เก็บ **LIFF ID** (รูปแบบ `1234567890-xxxxxxxx`) → `NEXT_PUBLIC_LIFF_ID`

### 2.3 ตั้ง Webhook URL (ทำหลัง deploy)

1. Messaging API → **Webhook URL**: `https://YOUR_DOMAIN/api/line/webhook`
2. เปิด **Use webhook**
3. กด **Verify** — ต้องได้ Success

---

## 3. Deploy บน Vercel

### 3.1 เตรียม env vars

คัดลอก `.env.example` เป็น `.env.local`:
```bash
cp .env.example .env.local
```
กรอกค่าให้ครบทุกบรรทัด (ดูขั้นตอน 1-2 สำหรับค่าแต่ละตัว)

สร้าง `ADMIN_SESSION_SECRET` (random 32+ ตัวอักษร):
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3.2 สร้าง ADMIN_PASSWORD_HASH

```bash
node scripts/hash-password.mjs YOUR_PASSWORD
```
คัดลอกผลลัพธ์ใส่ `ADMIN_PASSWORD_HASH` ใน `.env.local`

### 3.3 Deploy

```bash
npx vercel --prod
```
หรือ push ขึ้น GitHub แล้วเชื่อม Vercel กับ repository

ใส่ environment variables ทั้งหมดใน **Vercel → Settings → Environment Variables**

---

## 4. สร้าง Admin Account

ระบบรองรับ 2 วิธี:

**วิธีที่ 1 — Environment Variables** (เร็ว, admin เดียว):
```env
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD_HASH=scrypt$...
```

**วิธีที่ 2 — ตาราง `admin_users`** (รองรับหลายคน, กำหนด role ได้):
รัน SQL ใน Supabase SQL Editor:
```sql
-- สร้าง hash ก่อนด้วย: node scripts/hash-password.mjs YOUR_PASSWORD
insert into public.admin_users (email, role, password_hash)
values ('admin@example.com', 'admin', 'scrypt$...');

-- เพิ่ม viewer (ดูได้อย่างเดียว ดาวน์โหลดได้ แต่แก้ไขไม่ได้)
insert into public.admin_users (email, role, password_hash)
values ('viewer@example.com', 'viewer', 'scrypt$...');
```

---

## 5. ตั้งค่า Rich Menu

1. เปิด dashboard ที่ `https://YOUR_DOMAIN` แล้ว login
2. ไปที่ tab **LINE Settings**
3. กรอก **Contact URL** (ลิงก์ LINE OA สำหรับปุ่มติดต่อ)
4. กด **เผยแพร่ Rich Menu**
5. ตรวจใน LINE: เปิดแชทกับบอท จะเห็นเมนูด้านล่าง 3 ปุ่ม:
   - **สร้าง QR** — เปิด LIFF เลือกงาน
   - **ส่งสลิป** — เปิด LIFF แสดง QR ที่สร้างไว้
   - **สถานะ** — ตอบกลับสถานะการชำระเงิน

---

## 6. ตั้งค่าแจ้งเตือน Admin

เลือก **Telegram** หรือ **Discord** (หรือปล่อยเป็น Dashboard เท่านั้น)

### ตั้งค่า Telegram

1. หา `@BotFather` ใน Telegram → `/newbot` → เก็บ **Bot Token**
2. เพิ่มบอทเข้า group/channel ที่ต้องการแจ้งเตือน
3. หา **Chat ID** ของ group: ส่งข้อความใน group แล้วเปิด
   `https://api.telegram.org/bot{TOKEN}/getUpdates` ดูค่า `chat.id`
4. เข้า dashboard → tab **LINE Settings**:
   - เปลี่ยน **ช่องทางตรวจสลิปแอดมิน** → `Telegram`
   - ใส่ **Telegram Bot Token** และ **Telegram Chat ID**
   - กด **บันทึกตั้งค่า**

### ตั้งค่า Discord

1. เปิด Discord channel ที่ต้องการ → Edit Channel → Integrations → **Webhooks** → New Webhook
2. คัดลอก **Webhook URL**
3. เข้า dashboard → tab **LINE Settings**:
   - เปลี่ยน **ช่องทางตรวจสลิปแอดมิน** → `Discord`
   - ใส่ **Discord Webhook URL**
   - กด **บันทึกตั้งค่า**

---

## 7. ทดสอบ End-to-End

| ขั้น | การกระทำ | ผลที่คาดหวัง |
|------|----------|-------------|
| 1 | Add LINE บอทเป็นเพื่อน | ได้รับข้อความต้อนรับ + Rich Menu |
| 2 | กด "สร้าง QR" → เลือกงาน → เลือกชื่อ | แสดง QR PromptPay พร้อมยอด |
| 3 | ส่งรูปสลิปใน LINE chat | บอทตอบ "รับสลิปแล้ว" |
| 4 | รอ 2-3 วินาที | Telegram/Discord ได้รับ alert + ปุ่ม **อนุมัติ/ปฏิเสธ** |
| 5 | กด "อนุมัติ" จาก Telegram/Discord | เปิดหน้าเว็บยืนยัน + LINE push แจ้งผลกลับ user |
| 6 | กด "สถานะ" ใน LINE | Flex message แสดง "ชำระเงินแล้ว" พร้อมยอดและวันที่ |
| 7 | เปิด dashboard → tab Slips | สลิปแสดงสถานะ `verified` |

---

## สรุป Environment Variables

| ตัวแปร | ที่มา | จำเป็น |
|--------|------|--------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Settings → API | ✅ |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Settings → API | ✅ |
| `SUPABASE_SLIPS_BUCKET` | ค่าเริ่มต้น: `slips` | ✅ |
| `NEXT_PUBLIC_APP_URL` | URL ของ Vercel | ✅ |
| `LINE_CHANNEL_SECRET` | LINE Developers | ✅ |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Developers | ✅ |
| `NEXT_PUBLIC_LIFF_ID` | LINE Developers → LIFF | ✅ |
| `LINE_LIFF_CHANNEL_ID` | LINE Developers → Basic settings | ✅ |
| `ADMIN_EMAIL` | กำหนดเอง | ✅ |
| `ADMIN_PASSWORD_HASH` | `node scripts/hash-password.mjs` | ✅ |
| `ADMIN_SESSION_SECRET` | random 32+ chars | ✅ |
| `ADMIN_REVIEW_TOKEN_SECRET` | random 32+ chars (ไม่ใส่ก็ใช้ session secret) | ตัวเลือก |
