import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { ClickRipple } from '@/components/click-ripple'
import { ParticleBackground } from '@/components/particle-background'
import { SITE_URL } from '@/lib/site'
import './globals.css'

const SITE_TITLE = 'SlideShare & Scribd Downloader | PDF & PPTX | DocGrab'
const SITE_DESCRIPTION =
  'Download public SlideShare presentations, Scribd documents, and embedded PDF or PPTX files. Preserve source text when available and follow each step in a live process log.'
const SOCIAL_IMAGE = {
  url: '/opengraph-image.png',
  width: 1024,
  height: 1024,
  alt: 'DocGrab — download public SlideShare and Scribd documents as PDF or PPTX',
}

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: SITE_TITLE,
    template: '%s | DocGrab',
  },
  description: SITE_DESCRIPTION,
  applicationName: 'DocGrab',
  generator: 'Next.js',
  keywords: [
    'slideshare downloader',
    'scribd downloader',
    'download slideshare as pdf',
    'download scribd document',
    'slideshare to pdf',
    'scribd to pdf',
    'pdf and pptx downloader',
    'public document downloader',
    'presentation downloader',
    'preserve selectable text',
    'docgrab',
  ],
  authors: [{ name: 'Mhsm' }],
  creator: 'Mhsm',
  publisher: 'DocGrab',
  category: 'technology',
  alternates: {
    canonical: '/',
  },
  icons: {
    icon: '/icon.png',
    shortcut: '/icon.png',
    apple: '/apple-icon.png',
  },
  openGraph: {
    type: 'website',
    url: SITE_URL,
    siteName: 'DocGrab',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    locale: 'en_US',
    images: [SOCIAL_IMAGE],
  },
  twitter: {
    card: 'summary_large_image',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [SOCIAL_IMAGE.url],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1,
    },
  },
}

export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#191919',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="dark bg-background">
      <head>
        <meta name="google-site-verification" content="w1VFE8NiJGnum9YfpEI4V1jjmnkou7X9huKEw8_Zd4c" />
      </head>
      <body className="antialiased font-sans">
        <ParticleBackground />
        {children}
        <ClickRipple />
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
