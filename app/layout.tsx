import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import { ClickRipple } from '@/components/click-ripple'
import { ParticleBackground } from '@/components/particle-background'
import './globals.css'

const _geistSans = Geist({ subsets: ['latin'] })
const _geistMono = Geist_Mono({ subsets: ['latin'] })

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://docgrab.vercel.app'

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: 'DocGrab — Free SlideShare & Scribd to PDF Downloader',
    template: '%s | DocGrab',
  },
  description:
    'Download SlideShare presentations and Scribd documents as high-quality PDF files for free. Paste a link and DocGrab rebuilds every page into a clean PDF — no signup, no watermark, with a live process log.',
  applicationName: 'DocGrab',
  generator: 'v0.app',
  keywords: [
    'slideshare downloader',
    'scribd downloader',
    'download slideshare as pdf',
    'download scribd document',
    'slideshare to pdf',
    'scribd to pdf',
    'free document downloader',
    'presentation downloader',
    'pdf downloader',
    'download slideshare presentation',
    'scribd pdf download free',
    'docgrab',
  ],
  authors: [{ name: 'Mhsm' }],
  creator: 'Mhsm',
  publisher: 'DocGrab',
  category: 'technology',
  alternates: {
    canonical: '/',
  },
  openGraph: {
    type: 'website',
    url: siteUrl,
    siteName: 'DocGrab',
    title: 'DocGrab — Free SlideShare & Scribd to PDF Downloader',
    description:
      'Paste a SlideShare or Scribd link and download it as a clean, high-quality PDF for free. No signup, no watermark.',
    locale: 'en_US',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'DocGrab — Free SlideShare & Scribd to PDF Downloader',
    description:
      'Paste a SlideShare or Scribd link and download it as a clean, high-quality PDF for free. No signup, no watermark.',
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
