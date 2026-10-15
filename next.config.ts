import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The engine is pure TypeScript with no Node-only imports, so the same
  // simulation can run in the browser as a fallback when no GPU service is
  // attached. Nothing here needs to be polyfilled.
  reactStrictMode: true,
  // Standalone output keeps the container image to the traced dependency set
  // instead of a whole node_modules, which matters when the image is what a
  // judge runs. A PaaS builds its own output format, so standalone is requested
  // explicitly by the Dockerfile rather than assumed by every host.
  ...(process.env.BUILD_TARGET === 'docker' ? { output: 'standalone' } : {}),
  experimental: { inlineCss: true },
};

export default nextConfig;
