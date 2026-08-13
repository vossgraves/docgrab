/**
 * Public-proxy fallback for sources that block us outright.
 *
 * When plain fetch and the Chrome-TLS retry both come back as anti-bot
 * shells (or bare 403s), scrape free public proxy lists and retry the
 * request through the pool. Free proxies are flaky and short-lived, so no
 * validation pass is done up front: candidates are tried in rotation with
 * a short per-attempt timeout, and the first working one wins.
 *
 * Serverless note: the pool lives in function-instance memory with a five
 * minute TTL, so a cold start re-scrapes. That is fine — scrape sources
 * are plain-text and cheap.
 */

import { ProxyAgent } from "undici"
import type { Logger } from "./types"

const SOURCES = [
  "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
  "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
  "https://www.proxy-list.download/api/v1/get?type=https",
  "https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all",
]

const POOL_TTL_MS = 5 * 60_000
const POOL_CAP = 80
const FETCH_TIMEOUT_MS = 10_000

let pool: string[] = []
let poolFetchedAt = 0

/** Parse "host:port" lines from a proxy list dump. */
export function parseProxyLines(text: string): string[] {
  const out = new Set<string>()
  const octet = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)"
  const re = new RegExp(
    `^\\s*(${octet}\\.${octet}\\.${octet}\\.${octet}|\\[[0-9a-f:]+\\]|[0-9a-f:]{2,}):(\\d{2,5})\\s*$`,
    "im",
  )
  for (const line of text.split("\n")) {
    const match = line.match(re)
    if (!match) continue
    const port = Number(match[2])
    if (port < 1 || port > 65535) continue
    const host = match[1].toLowerCase()
    if (host.startsWith("127.") || host === "localhost" || host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("169.254.")) continue
    out.add(`${host}:${port}`)
  }
  return [...out]
}

async function scrapeProxies(log: Logger): Promise<string[]> {
  const jobs = SOURCES.map(async (url) => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (!res.ok) return []
      return parseProxyLines(await res.text())
    } catch {
      return []
    }
  })
  const settled = await Promise.allSettled(jobs)
  const merged = new Set<string>()
  for (const result of settled) {
    if (result.status === "fulfilled") for (const proxy of result.value) merged.add(proxy)
  }
  const list = [...merged].sort(() => Math.random() - 0.5).slice(0, POOL_CAP)
  log("info", `Scraped ${list.length} public proxies from ${SOURCES.length} sources`)
  return list
}

/** Rotate the pool; returns the next candidate. Re-scrapes when stale. */
export async function acquireProxy(log: Logger): Promise<string | null> {
  const now = Date.now()
  if (pool.length === 0 || now - poolFetchedAt > POOL_TTL_MS) {
    pool = await scrapeProxies(log)
    poolFetchedAt = now
  }
  if (pool.length === 0) return null
  const proxy = pool.shift() as string
  pool.push(proxy) // round-robin
  return proxy
}

const agents = new Map<string, ProxyAgent>()

function agentFor(proxy: string): ProxyAgent {
  let agent = agents.get(proxy)
  if (!agent) {
    agent = new ProxyAgent({ uri: `http://${proxy}`, connect: { timeout: 8_000 } })
    agents.set(proxy, agent)
    if (agents.size > 10) {
      // ponytail: evict oldest; proxy lifespan is minutes anyway
      const oldest = agents.keys().next().value
      if (oldest !== undefined) {
        const evicted = agents.get(oldest)
        agents.delete(oldest)
        evicted?.close().catch(() => {})
      }
    }
  }
  return agent
}

export interface ProxyFetchResult {
  status: number
  contentType: string
  body: Buffer
}

/**
 * Fetch a URL through one proxy. Returns null when the proxy fails or the
 * request times out; callers treat a non-null result as "the proxy worked".
 */
export async function fetchViaProxy(
  url: string,
  proxy: string,
  headers: Record<string, string>,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<ProxyFetchResult | null> {
  try {
    const res = await fetch(url, {
      dispatcher: agentFor(proxy),
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    } as RequestInit & { dispatcher?: ProxyAgent })
    const body = Buffer.from(await res.arrayBuffer())
    return { status: res.status, contentType: res.headers.get("content-type") ?? "", body }
  } catch {
    return null
  }
}