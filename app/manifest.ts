import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'DocGrab — Public SlideShare & Scribd Downloader',
    short_name: 'DocGrab',
    description:
      'Download public SlideShare presentations, Scribd documents, and embedded PDF or PPTX files when the source exposes them.',
    start_url: '/',
    display: 'standalone',
    background_color: '#191919',
    theme_color: '#191919',
    icons: [
      {
        src: '/icon.png',
        sizes: '1024x1024',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/apple-icon.png',
        sizes: '180x180',
        type: 'image/png',
        purpose: 'any',
      },
    ],
  }
}
