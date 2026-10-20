import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["@anthropic-ai/sdk"],
};
export default config;
