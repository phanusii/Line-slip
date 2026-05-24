#!/usr/bin/env node
/**
 * สร้าง password hash สำหรับใส่ใน ADMIN_PASSWORD_HASH
 *
 * วิธีใช้:
 *   node scripts/hash-password.mjs YOUR_PASSWORD
 *
 * ตัวอย่าง output:
 *   scrypt$abc123$derived_key_here
 *
 * คัดลอกผลลัพธ์ไปใส่ใน .env.local:
 *   ADMIN_PASSWORD_HASH=scrypt$...
 */

import { randomBytes, scryptSync } from "node:crypto";

const password = process.argv[2];

if (!password) {
  console.error("กรุณาระบุรหัสผ่าน: node scripts/hash-password.mjs YOUR_PASSWORD");
  process.exit(1);
}

if (password.length < 8) {
  console.error("รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร");
  process.exit(1);
}

const salt = randomBytes(16).toString("base64url");
const derived = scryptSync(password, salt, 64).toString("base64url");
const hash = `scrypt$${salt}$${derived}`;

console.log("\nADMIN_PASSWORD_HASH=" + hash + "\n");
console.log("คัดลอกบรรทัดด้านบนไปใส่ใน .env.local ของคุณ");
