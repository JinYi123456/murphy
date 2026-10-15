import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The engine is pure TypeScript with no Node-only imports, so the same
  // simulation can run in the browser as a fallback when no GPU service is
  // attached. Nothing here needs to be polyfilled.
  reactStrictMode: true,
  experimental: { inlineCss: true },
};

export default nextConfig;
