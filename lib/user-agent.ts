/**
 * Built-in User-Agent generator.
 *
 * A single hardcoded UA is an easy flag target for CDNs: the same string
 * hitting the same endpoints thousands of times looks like a bot. This module
 * generates a fresh, realistic desktop Chrome UA per download so every
 * request looks like an ordinary new visitor.
 *
 * Notes:
 * - Modern Chrome reports a reduced UA (`Chrome/126.0.0.0`) — only the major
 *   version varies, so that is all we jitter. Anything fancier would stand out.
 * - On serverless hosting each function instance keeps its own counter, which
 *   is fine: more instances simply means more natural UA diversity.
 */

/** Current desktop Chrome major versions (stable +/- a couple of releases). */
const CHROME_MAJORS = [124, 125, 126, 127, 128]

/** Realistic desktop platform strings. */
const PLATFORMS = [
  "Windows NT 10.0; Win64; x64",
  "Macintosh; Intel Mac OS X 10_15_7",
  "X11; Linux x86_64",
]

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

/** Generate a fresh, realistic Chrome desktop User-Agent. */
export function generateUserAgent(): string {
  const major = pick(CHROME_MAJORS)
  const platform = pick(PLATFORMS)
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}

let activeUA = generateUserAgent()

/**
 * Register one download job and rotate to a brand new UA immediately, so
 * every download looks like a first-time visitor.
 */
export function registerDownload(): void {
  activeUA = generateUserAgent()
}

/** The currently active User-Agent. Fresh for every registered download. */
export function getUserAgent(): string {
  return activeUA
}
