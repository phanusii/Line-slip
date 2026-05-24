# ระบบจัดการสลิป LINE

ระบบต้นแบบสำหรับรับสลิปจาก LINE, สร้าง PromptPay QR ฟรีในตัวแอป, เก็บรูปใน Supabase Storage, เก็บ metadata ใน Supabase Database, ดู usage และล้างข้อมูลสลิปเป็นรายงาน

ระบบนี้ไม่เรียก API ตรวจสลิปแบบเสียเงิน สลิปใหม่จะถูกบันทึกเป็น `manual_review` เพื่อให้ผู้ดูแลเปิดดูและอนุมัติ/ปฏิเสธเอง ส่วนสลิปที่รูปหรือ QR ซ้ำจะถูกบล็อกก่อนบันทึก ไม่สร้างไฟล์หรือ record ซ้ำใหม่
ระบบอ่าน QR บนรูปสลิปด้วย `jsQR` บนเซิร์ฟเวอร์ของตัวเองเพื่อช่วยกันสลิปวนซ้ำ แต่ยังไม่ถือว่าเป็นหลักฐานยืนยันว่าเงินเข้าจริงจนกว่าแอดมินจะอนุมัติ

## Setup

1. สร้าง Supabase project แล้วรัน SQL ใน `supabase/schema.sql`
2. คัดลอก `.env.example` เป็น `.env.local` แล้วกรอกค่า Supabase/LINE
3. ติดตั้ง dependency และรัน dev server

```bash
npm install
npm run dev
```

## ผู้ดูแลระบบ

หน้าเว็บใช้ session cookie แบบ httpOnly หลังล็อกอิน ผู้ดูแลสามารถมาจากตาราง `admin_users` หรือ fallback จาก environment variables:

```env
ADMIN_EMAIL=
ADMIN_PASSWORD_HASH=
ADMIN_SESSION_SECRET=
```

สร้าง password hash ได้ด้วยคำสั่ง:

```bash
node -e "const {scryptSync,randomBytes}=require('crypto');const s=randomBytes(16).toString('base64url');console.log('scrypt$'+s+'$'+scryptSync('YOUR_PASSWORD',s,64).toString('base64url'))"
```

## LINE/LIFF

- `GET /api/liff/events` ต้องเรียกจาก LIFF พร้อม LINE access token เท่านั้น
- `POST /api/liff/slip` ใช้อัปโหลดสลิปจาก LIFF พร้อม LINE access token และผูกกับรายชื่อที่สร้าง QR ไว้
- `POST /api/line/webhook` ตรวจ `x-line-signature` และตอบ `401` เมื่อ signature ไม่ถูกต้อง
- `NEXT_PUBLIC_LIFF_ID` และ `LINE_LIFF_CHANNEL_ID` ต้องตรงกับ LIFF channel ที่ใช้งานจริง

## แจ้งเตือนแอดมินและผู้ใช้

- หน้าแอดมินมีคิว `สลิปรอตรวจ`, เสียงแจ้งเตือน และ Browser Notification เมื่อเปิด dashboard ค้างไว้
- ตั้งค่า Telegram หรือ Discord ได้จากหน้า `ตั้งค่า LINE`; Telegram รองรับการเชื่อมบอทจากหน้าเว็บ, แป้นลัดล่างถาวร, แจ้งเตือนรูปสลิปใหม่ และปุ่มอนุมัติ/ปฏิเสธในแชท
- การแจ้งผลผู้ใช้ทาง LINE ใช้โหมด `quota_aware`: ระบบเช็กโควตา LINE ก่อน push ถ้าไม่เหลือจะไม่ส่ง และให้ LIFF status เป็นแหล่งข้อมูลหลัก
- ถ้าต้องการปิด push ทั้งหมด ให้ตั้ง `line_push_policy` เป็น `disabled`
