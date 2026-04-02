import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  experimental: {
    webpackBuildWorker: false,
  },
};

export default nextConfig;
