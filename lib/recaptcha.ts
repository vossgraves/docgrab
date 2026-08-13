/**
 * reCAPTCHA detection and solving.
 *
 * Detection is free: parse the page shell for the widget markers and pull
 * out the sitekey plus version. Solving requires a captcha-solving service
 * key in CAPTCHA_API_KEY (2captcha, captchaai, or any provider speaking the
 * classic in.php / res.php protocol). The keyless "Buster" trick — Google's
 * own speech-api with the leaked chromium key — has been revoked by Google
 * (403 invalid key), so a service key is the only reliable server-side path.
 *
 * The solved token is replayed against the source as both a cookie and a
 * header, which covers the two ways challenge-gated sites consume it.
 */

import type { Logger } from "./types"

export interface RecaptchaWidget {
  sitekey: string
  version: "v2" | "v3"
}

const SITEKEY_RE = /[A-Za-z0-9_-]{40}/

const V2_PATTERNS = [
  /data-sitekey\s*=\s*["']([A-Za-z0-9_-]{40,})["']/i,
  /grecaptcha\.render\s*\(\s*(?:["'][^"']*["']\s*,\s*)?\{[^}]*?["']sitekey["']\s*:\s*["']([A-Za-z0-9_-]{40,})["']/i,
]

const V3_PATTERNS = [
  /recaptcha\/api\.js\?render\s*=\s*([A-Za-z0-9_-]{40,})/i,
  /["']sitekey["']\s*:\s*["']([A-Za-z0-9_-]{40,})["'][^}]*?["']size["']\s*:\s*["']invisible["']/i,
]

/** Detect a reCAPTCHA widget in page markup. Returns null when absent. */
export function extractRecaptcha(html: string): RecaptchaWidget | null {
  if (!html || !/recaptcha/i.test(html.slice(0, 60000))) return null

  for (const re of V3_PATTERNS) {
    const match = html.match(re)
    if (match?.[1] && SITEKEY_RE.test(match[1])) {
      return { sitekey: match[1], version: "v3" }
    }
  }
  for (const re of V2_PATTERNS) {
    const match = html.match(re)
    if (match?.[1] && SITEKEY_RE.test(match[1])) {
      return { sitekey: match[1], version: "v2" }
    }
  }
  return null
}

const DEFAULT_API_BASE = "https://2captcha.com"
const POLL_INTERVAL_MS = 5_000
const MAX_POLLS = 30 // ~150s ceiling; the function runs at 300s max

function apiBase(): string {
  return (process.env.CAPTCHA_API_URL ?? DEFAULT_API_BASE).replace(/\/+$/, "")
}

function submitParams(widget: RecaptchaWidget, pageUrl: string) {
  const params: Record<string, string> = {
    key: process.env.CAPTCHA_API_KEY ?? "",
    method: "userrecaptcha",
    googlekey: widget.sitekey,
    pageurl: pageUrl,
    json: "1",
  }
  if (widget.version === "v3") {
    params.version = "v3"
    params.action = "homepage"
    params.min_score = "0.3"
  }
  return new URLSearchParams(params)
}

/**
 * Solve a reCAPTCHA widget through the configured service.
 * Returns the g-recaptcha-response token, or null when no key is
 * configured, the solve failed, or it timed out.
 */
export async function solveRecaptcha(
  widget: RecaptchaWidget,
  pageUrl: string,
  log: Logger,
): Promise<string | null> {
  const key = process.env.CAPTCHA_API_KEY
  if (!key) {
    log("warn", "reCAPTCHA detected but CAPTCHA_API_KEY is not configured — cannot solve")
    return null
  }

  const base = apiBase()
  let id: string | null = null
  try {
    const submit = await fetch(`${base}/in.php`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: submitParams(widget, pageUrl),
      signal: AbortSignal.timeout(20_000),
    })
    const body = await submit.text()
    const data = JSON.parse(body)
    if (data.status !== 1) {
      log("warn", `Captcha service rejected the task: ${body.slice(0, 200)}`)
      return null
    }
    id = data.request
    log("info", `Captcha task submitted (${widget.version}, id ${id}) — waiting for the solve...`)
  } catch (error) {
    log("warn", `Captcha submit failed: ${error instanceof Error ? error.message : "unknown error"}`)
    return null
  }

  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    try {
      const poll = await fetch(
        `${base}/res.php?${new URLSearchParams({ key, action: "get", id: id as string, json: "1" })}`,
        { signal: AbortSignal.timeout(20_000) },
      )
      const data = await poll.json()
      if (data.status === 1 && typeof data.request === "string") {
        log("success", "Captcha solved")
        return data.request
      }
      if (data.status !== 0 && data.request !== "CAPCHA_NOT_READY") {
        log("warn", `Captcha poll error: ${JSON.stringify(data).slice(0, 200)}`)
        return null
      }
    } catch (error) {
      log("warn", `Captcha poll failed: ${error instanceof Error ? error.message : "unknown error"}`)
      return null
    }
  }
  log("warn", "Captcha solve timed out")
  return null
}

/** Headers/cookie that replay a solved token onto a fresh request. */
export function recaptchaReplayHeaders(token: string): { cookie: string; headers: Record<string, string> } {
  return {
    cookie: `g-recaptcha-response=${encodeURIComponent(token)}`,
    headers: { "g-recaptcha-response": token },
  }
}
