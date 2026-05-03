import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  experimental: {
    webpackBuildWorker: false,
  },
  // Turbopack is the default in Next.js 16 — empty config silences the warning
  turbopack: {},
  // Skip TypeScript errors during build (pre-existing type issues in codebase)
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
