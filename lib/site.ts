const PRIMARY_SITE_URL = 'https://docgrab.vossgraves.cyou'

const configuredSiteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, '')

// Keep the public custom domain canonical even if an older Vercel environment
// variable is still present in the deployment settings.
export const SITE_URL =
  configuredSiteUrl && !configuredSiteUrl.includes('docgrab.vercel.app')
    ? configuredSiteUrl
    : PRIMARY_SITE_URL

export const SITE_NAME = 'DocGrab'
