import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: "8mb"
    }
  },
  // @napi-rs/canvas ships a pre-built native binary (.node file).
  // Tell Next.js not to bundle it — load it from node_modules at runtime.
  serverExternalPackages: ["@napi-rs/canvas"]
};

export default nextConfig;
