/**
 * Lightweight in-memory sliding-window rate limiter, keyed by client IP.
 *
 * Notes for serverless deployments: each warm function instance keeps its own
 * window map, so the effective global limit is (limit x instances). That is
 * still a strong defense for this app because the expensive work (headless
 * Chrome, image pipelines) runs inside the same instance being protected.
 * No external storage is needed and there is zero added latency.
 */

interface Window {
  /** Timestamps (ms) of requests within the current window. */
  hits: number[]
}

const WINDOW_MS = 10 * 60 * 1000 // 10 minutes
const MAX_REQUESTS = 5 // per window per IP
const MAX_TRACKED_IPS = 10_000 // hard cap so the map can never grow unbounded

const windows = new Map<string, Window>()

/** Periodically prune stale entries so long-lived instances stay lean. */
let lastSweep = Date.now()
function sweep(now: number) {
  if (now - lastSweep < WINDOW_MS) return
  lastSweep = now
  for (const [key, win] of windows) {
    win.hits = win.hits.filter((t) => now - t < WINDOW_MS)
    if (win.hits.length === 0) windows.delete(key)
  }
}

export interface RateLimitResult {
  allowed: boolean
  /** Requests remaining in the current window. */
  remaining: number
  /** Seconds until the oldest hit falls out of the window (when blocked). */
  retryAfterSeconds: number
}

export function checkRateLimit(clientKey: string): RateLimitResult {
  const now = Date.now()
  sweep(now)

  let win = windows.get(clientKey)
  if (!win) {
    // Refuse to track new clients past the cap rather than allowing unbounded memory.
    if (windows.size >= MAX_TRACKED_IPS) {
      return { allowed: false, remaining: 0, retryAfterSeconds: 60 }
    }
    win = { hits: [] }
    windows.set(clientKey, win)
  }

  win.hits = win.hits.filter((t) => now - t < WINDOW_MS)

  if (win.hits.length >= MAX_REQUESTS) {
    const oldest = win.hits[0]
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000))
    return { allowed: false, remaining: 0, retryAfterSeconds }
  }

  win.hits.push(now)
  return { allowed: true, remaining: MAX_REQUESTS - win.hits.length, retryAfterSeconds: 0 }
}

/** Extract the best-effort client IP from a Next.js request. */
export function getClientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim()
    if (first) return first
  }
  return headers.get("x-real-ip")?.trim() || "unknown"
}

/**
 * Build a composite client fingerprint from IP + User-Agent.
 *
 * A raw IP is trivially spoofable via forged x-forwarded-for headers, and many
 * users legitimately share one IP (NAT, corporate proxies). Folding in the
 * User-Agent makes the key harder to forge consistently and reduces collateral
 * blocking of unrelated users behind the same IP. It is defense-in-depth, not a
 * cryptographic identity — an attacker can still rotate both values.
 */
export function getClientKey(headers: Headers): string {
  const ip = getClientIp(headers)
  const ua = headers.get("user-agent")?.trim() || "no-ua"
  return `${ip}::${djb2(ua)}`
}

/** Small, fast non-crypto hash to keep the UA portion compact and bounded. */
function djb2(str: string): string {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i)
  }
  return (hash >>> 0).toString(36)
}
