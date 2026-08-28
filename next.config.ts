import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // O core roda tanto no Next quanto no worker; nada de APIs de browser lá.
  serverExternalPackages: ["@prisma/client", "@anthropic-ai/sdk"],
  typedRoutes: true,
};

export default nextConfig;
