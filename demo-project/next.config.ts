import type { NextConfig } from 'next';

const config: NextConfig = {
  // Standalone output: the Hosting agent serves the built app from .next/standalone.
  output: 'standalone',
  reactStrictMode: true,
};

export default config;
