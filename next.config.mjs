/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: false,
  },
  serverExternalPackages: ['puppeteer-core', '@sparticuz/chromium'],
  // @jsquash is loaded via a hidden runtime import (see lib/webp.ts) so
  // Turbopack never traces it. Force its full package contents (JS glue +
  // .wasm binaries) into the serverless bundle for /api/download.
  outputFileTracingIncludes: {
    '/api/download': [
      './node_modules/@jsquash/webp/**',
      './node_modules/@jsquash/jpeg/**',
      './node_modules/.pnpm/@jsquash+webp@*/node_modules/@jsquash/webp/**',
      './node_modules/.pnpm/@jsquash+jpeg@*/node_modules/@jsquash/jpeg/**',
    ],
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
