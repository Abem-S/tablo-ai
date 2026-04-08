import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  experimental: {
    webpackBuildWorker: false,
  },
};

export default nextConfig;
