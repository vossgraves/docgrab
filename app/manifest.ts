import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'DocGrab — SlideShare & Scribd to PDF Downloader',
    short_name: 'DocGrab',
    description:
      'Download SlideShare presentations and Scribd documents as high-quality PDF files for free.',
    start_url: '/',
    display: 'standalone',
    background_color: '#191919',
    theme_color: '#191919',
    icons: [
      {
        src: '/icon.png',
        sizes: '512x512',
        type: 'image/png',
      },
    ],
  }
}
