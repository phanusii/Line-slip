export function getEnv(name: string, fallback?: string) {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const STORAGE_BUCKET = process.env.SUPABASE_SLIPS_BUCKET ?? "slips";
