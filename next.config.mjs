/** @type {import('next').NextConfig} */
const chromiumFiles = [
  './node_modules/@sparticuz/chromium/**',
  './node_modules/@sparticuz/chromium/bin/**',
  './node_modules/.pnpm/@sparticuz+chromium@*/node_modules/@sparticuz/chromium/**',
  './node_modules/.pnpm/@sparticuz+chromium@*/node_modules/@sparticuz/chromium/bin/**',
]

const nextConfig = {
  typescript: {
    ignoreBuildErrors: false,
  },
  serverExternalPackages: ['puppeteer-core', '@sparticuz/chromium'],
  // @jsquash is loaded via a hidden runtime import (see lib/webp.ts) so
  // Turbopack never traces it. Keep Chromium external, but force the full
  // package (including compressed binaries) into every serverless trace.
  outputFileTracingIncludes: {
    '/*': [
      ...chromiumFiles,
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
