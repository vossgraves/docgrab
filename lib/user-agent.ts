/**
 * Built-in User-Agent generator with automatic rotation.
 *
 * A single hardcoded UA is an easy flag target for CDNs: the same string
 * hitting the same endpoints thousands of times looks like a bot. This module
 * generates realistic, current desktop UAs and rotates the active one every
 * ROTATE_EVERY downloads, so traffic blends in with normal browser churn.
 *
 * Notes:
 * - Modern Chrome reports a reduced UA (`Chrome/126.0.0.0`) — only the major
 *   version varies, so that is all we jitter. Anything fancier would stand out.
 * - On serverless hosting each function instance keeps its own counter, which
 *   is fine: more instances simply means more natural UA diversity.
 */

const ROTATE_EVERY = 50

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

let downloadsSinceRotation = 0
let activeUA = generateUserAgent()

/**
 * Register one download job. Rotates the active UA after every
 * ROTATE_EVERY downloads. Call once per download request.
 */
export function registerDownload(): void {
  downloadsSinceRotation++
  if (downloadsSinceRotation >= ROTATE_EVERY) {
    downloadsSinceRotation = 0
    activeUA = generateUserAgent()
  }
}

/** The currently active User-Agent. Stable within a rotation window. */
export function getUserAgent(): string {
  return activeUA
}
