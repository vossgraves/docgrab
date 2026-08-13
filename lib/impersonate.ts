/**
 * Chrome-TLS fetch fallback for challenge-protected sources.
 *
 * Some document hosts (Cloudflare, Fastly, hCaptcha/Turnstile-protected
 * sites, etc.) block traffic whose TLS/HTTP2 fingerprint is not a real
 * browser. Node's built-in fetch cannot impersonate a browser, so when a
 * page smells like an anti-bot challenge we retry it with the official
 * curl-impersonate binary (the same engine curl_cffi is built on), which
 * speaks Chrome's TLS fingerprint.
 *
 * Scope and limits:
 * - Only used as a FALLBACK after a challenge is detected. Ordinary fetches
 *   keep using plain `fetch`.
 * - It does NOT solve interactive CAPTCHAs. A JS challenge that requires
 *   human interaction (reCAPTCHA, hCaptcha, Turnstile, "enter the
 *   characters") cannot be solved by any HTTP client, and DocGrab does not
 *   attempt to solve them. Such pages fail with a clear, honest error.
 * - The binary is vendored at vendor/curl_chrome116 (linux x86_64,
 *   matching Vercel's build). curl-impersonate v0.6.1 selects the
 *   fingerprint profile from the executable name, so it is named after the
 *   newest bundled profile (Chrome 116); override with the
 *   CURL_IMPERSONATE_PATH environment variable.
 */

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomBytes } from "node:crypto"
import { unlink } from "node:fs/promises"
import type { Logger } from "./types"

const BINARY_CANDIDATES = [
  process.env.CURL_IMPERSONATE_PATH,
  join(process.cwd(), "vendor", "curl_chrome116"),
].filter(Boolean) as string[]

function binaryPath(log: Logger): string | null {
  const found = BINARY_CANDIDATES.find((p) => existsSync(p))
  if (found) return found
  log("warn", "curl-impersonate binary not found (vendor/curl_chrome116 is missing); your hosting arch may differ. Emitting a clear error for challenge-protected sources.")
  return null
}

/**
 * Common markers of anti-bot challenge SHELLS served instead of real
 * content. Deliberately excludes /cdn-cgi/challenge-platform/: Cloudflare's
 * "managed challenge" injects that script into pages that still contain the
 * full real content, so its mere presence must not be treated as an
 * unsolvable CAPTCHA. We only escalate when the page looks like a shell
 * (Turnstile/hCaptcha/reCAPTCHA widgets, "__cf_chl_" challenge pages,
 * Fastly _fs-ch, "Just a moment", "Attention Required", ...).
 */
const CHALLENGE_PATTERNS = [
  /__cf_chl_/i,
  /cf-chl-widget/i,
  /cf-chl-/i,
  /cf-turnstile/i,
  /hcaptcha\.com/i,
  /g-recaptcha|recaptcha\//i,
  /just a moment/i,
  /attention required/i,
  /_fs-ch-/i,
  /client challenge/i,
  /enter the characters seen in the image/i,
  /enable javascript and cookies to continue/i,
]

export function isChallengePage(html: string): boolean {
  if (!html) return false
  const haystack = html.slice(0, 60000)
  return CHALLENGE_PATTERNS.some((re) => re.test(haystack))
}

export interface ImpersonatedResponse {
  status: number
  contentType: string
  buffer: Buffer
  mitigated: boolean
}

/**
 * Fetch a URL with a Chrome TLS fingerprint via the curl-impersonate
 * binary. Returns null when the binary is unavailable or the request
 * failed outright.
 */
export async function fetchImpersonated(
  url: string,
  log: Logger,
  timeoutMs = 45000,
): Promise<ImpersonatedResponse | null> {
  const binary = binaryPath(log)
  if (!binary) return null

  const tmp = join(tmpdir(), `docgrab-ci-${randomBytes(6).toString("hex")}.bin`)
  const seconds = Math.max(5, Math.floor(timeoutMs / 1000))

  return new Promise((resolve) => {
    let stdout = ""
    const child = spawn(binary, [url, "-sS", "-L", "--compressed", "-D", "-", "-o", tmp, "--max-time", String(seconds)], {
      stdio: ["ignore", "pipe", "ignore"],
    })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
    }, timeoutMs + 5000)

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("latin1")
    })

    child.on("error", (error) => {
      clearTimeout(timer)
      log("warn", `curl-impersonate failed to start: ${error.message}`)
      resolve(null)
    })

    child.on("close", async (code) => {
      clearTimeout(timer)
      try {
        const statusMatch = stdout.match(/^HTTP\/[\d.]+ (\d{3})/m)
        const status = statusMatch ? Number(statusMatch[1]) : 0
        const typeMatch = stdout.match(/^content-type:\s*(.+)$/im)
        const contentType = typeMatch ? typeMatch[1].trim() : ""
        const mitigated = /^cf-mitigated:\s*challenge$/im.test(stdout)
        const buffer = await import("node:fs/promises").then((fs) => fs.readFile(tmp))
        resolve({ status, contentType, buffer, mitigated })
      } catch {
        resolve(null)
      } finally {
        unlink(tmp).catch(() => {})
      }
    })
  })
}