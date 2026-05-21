export function getEnv(name: string, fallback?: string) {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`ยังไม่ได้ตั้งค่าตัวแปรระบบที่จำเป็น: ${name}`);
  }
  return value;
}

export const STORAGE_BUCKET = process.env.SUPABASE_SLIPS_BUCKET ?? "slips";
