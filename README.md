# ระบบจัดการสลิป LINE

ระบบต้นแบบสำหรับรับสลิปจาก LINE, เก็บรูปใน Supabase Storage, เก็บ metadata ใน Supabase Database, ดู usage และล้างข้อมูลสลิปเป็นรายงาน

## Setup

1. สร้าง Supabase project แล้วรัน SQL ใน `supabase/schema.sql`
2. คัดลอก `.env.example` เป็น `.env.local` แล้วกรอกค่า Supabase/LINE
3. ติดตั้ง dependency และรัน dev server

```bash
npm install
npm run dev
```

## สิทธิ์ผู้ดูแล

API ที่แก้ข้อมูลใช้ header:

```text
x-admin-secret: ค่า ADMIN_SHARED_SECRET
```

หน้าเว็บใช้รหัสผู้ดูแลจาก `ADMIN_SHARED_SECRET` สำหรับดู/ดาวน์โหลด/ลบ/แก้สถานะ และรองรับ `VIEWER_SHARED_SECRET` แบบ optional สำหรับสิทธิ์ดูและดาวน์โหลดเท่านั้น
