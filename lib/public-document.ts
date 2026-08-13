import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { storeForDownload } from "./delivery"
import { generateUserAgent, getUserAgent } from "./user-agent"
import { fetchImpersonated, isChallengePage } from "./impersonate"
import { extractRecaptcha, solveRecaptcha, recaptchaReplayHeaders } from "./recaptcha"
import { acquireProxy, fetchViaProxy } from "./proxy"
import type { DownloadOptions, Logger, OutputFormat, ProgressReporter } from "./types"

const MAX_SOURCE_BYTES = 200 * 1024 * 1024
const SOURCE_TIMEOUT_MS = 45_000

export type PublicDocumentExtension = "pdf" | "ppt" | "pptx"

export interface PublicDocumentCandidate {
  url: string
  extension: PublicDocumentExtension
  score: number
}

export interface PublicDocumentResult {
  id: string
  title: string
  pages: number
  size: string
  format: OutputFormat
  platform: "public"
  textSelectable: boolean
  sourceUrl: string
  cachedUrl?: string
  cachedExpiresAt?: number
  catboxUrl?: string
  catboxExpiresAt?: number
  fileBase64?: string
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
}

function extensionFromUrl(url: string, contentType = ""): PublicDocumentExtension | null {
  try {
    const pathname = new URL(url).pathname.toLowerCase()
    const match = pathname.match(/\.(pdf|pptx?|)$/i)
    if (match?.[1]) return match[1].toLowerCase() as PublicDocumentExtension
  } catch {
    // Fall back to the content type below.
  }

  const type = contentType.toLowerCase().split(";")[0].trim()
  if (type === "application/pdf") return "pdf"
  if (type === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return "pptx"
  if (type === "application/vnd.ms-powerpoint") return "ppt"
  return null
}

function normalizeCandidate(raw: string, pageUrl: string): PublicDocumentCandidate | null {
  const decoded = decodeHtml(raw.replace(/\\\//g, "/").trim())
  if (!decoded || /^(?:javascript|data|blob|mailto):/i.test(decoded)) return null

  let parsed: URL
  try {
    parsed = new URL(decoded, pageUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null

  const extension = extensionFromUrl(parsed.toString())
  if (!extension) return null

  // Fragments never affect the fetched file and make duplicate detection noisy.
  parsed.hash = ""
  const normalized = parsed.toString()
  let score = 0
  if (extension === "pdf") score += 4
  if (extension === "pptx") score += 3
  if (/\/download(?:\/|\?|$)|\/documents?\//i.test(parsed.pathname + parsed.search)) score += 2
  if (/cdn|cloudfront|storage|static|assets?/i.test(parsed.hostname + parsed.pathname)) score += 1
  if (parsed.hostname === new URL(pageUrl).hostname) score += 1

  return { url: normalized, extension, score }
}

function extractAttributeUrls(html: string): string[] {
  const urls: string[] = []
  const attrPattern = /(?:href|src|data|data-src|data-url|content)\s*=\s*(["'])(.*?)\1/gi
  for (const match of html.matchAll(attrPattern)) urls.push(match[2])
  return urls
}

function extractDocumentUrlsFromText(html: string): string[] {
  const urls: string[] = []
  const directPattern = /https?:\/\/[^"'<>\s)\]}]+?\.(?:pdf|pptx?)(?:\?[^"'<>\s)\]}]*)?/gi
  for (const match of html.matchAll(directPattern)) urls.push(match[0])
  return urls
}

export function extractPublicDocumentCandidates(html: string, pageUrl: string): PublicDocumentCandidate[] {
  const candidates = new Map<string, PublicDocumentCandidate>()
  const values = [...extractAttributeUrls(html), ...extractDocumentUrlsFromText(html)]
  for (const value of values) {
    const candidate = normalizeCandidate(value, pageUrl)
    if (!candidate) continue
    const previous = candidates.get(candidate.url)
    if (!previous || candidate.score > previous.score) candidates.set(candidate.url, candidate)
  }

  return [...candidates.values()].sort((a, b) => b.score - a.score || a.url.length - b.url.length).slice(0, 12)
}

export function extractPageTitle(html: string, fallback: string): string {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const ogMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
  const raw = decodeHtml((ogMatch?.[1] ?? titleMatch?.[1] ?? fallback).replace(/<[^>]+>/g, " "))
  const title = raw.replace(/\s+/g, " ").trim()
  return title || fallback
}

function isPrivateIp(address: string): boolean {
  if (isIP(address) === 4) {
    const octets = address.split(".").map(Number)
    const [a, b] = octets
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  }
  const normalized = address.toLowerCase()
  return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")
}

export async function assertPublicUrl(rawUrl: string): Promise<void> {
  const parsed = new URL(rawUrl)
  const hostname = parsed.hostname.toLowerCase().replace(/[\[\]]/g, "").replace(/\.$/, "")
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Only HTTP(S) document sources are supported.")
  if (!hostname || hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal") || isPrivateIp(hostname)) {
    throw new Error("Private or local document sources are not allowed.")
  }
  if (isIP(hostname)) return
  const addresses = await lookup(hostname, { all: true, verbatim: true })
  if (addresses.length === 0 || addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new Error("The document host resolves to a private address.")
  }
}

/**
 * Fetch a page with an escalating fallback ladder:
 *   1. plain fetch (per-download UA)
 *   2. Chrome TLS fingerprint (curl-impersonate) for Cloudflare/Fastly walls
 *   3. reCAPTCHA solve via service (CAPTCHA_API_KEY) + replay with the token
 *   4. scrape public proxies and retry through the pool
 * Interactive CAPTCHAs that no stage can overcome are reported back as
 * reason "challenge".
 */
type FallbackFetchResult =
  | { ok: true; body: Buffer; contentType: string; status: number }
  | { ok: false; reason: "network" | "challenge" | "oversize" }

const MAX_PROXY_ATTEMPTS = 3

async function fetchWithImpersonationFallback(
  url: string,
  log: Logger,
  timeoutMs = SOURCE_TIMEOUT_MS,
): Promise<FallbackFetchResult> {
  await assertPublicUrl(url)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response: Response
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": getUserAgent(),
        Accept: "text/html,application/xhtml+xml,application/pdf,*/*;q=0.8",
      },
      signal: controller.signal,
      redirect: "follow",
    })
  } catch {
    clearTimeout(timer)
    return { ok: false, reason: "network" }
  }
  clearTimeout(timer)

  const contentLength = Number(response.headers.get("content-length") ?? "0")
  if (contentLength > MAX_SOURCE_BYTES) return { ok: false, reason: "oversize" }
  const text = await response.text()
  // A 403 with no content is the classic bot-wall signature (e.g. plain
  // Node fetch gets 403 from some CDNs where a Chrome fingerprint gets 200).
  const challenged =
    response.headers.get("cf-mitigated") === "challenge" ||
    response.status === 403 ||
    isChallengePage(text)
  if (!challenged) {
    const body = Buffer.from(text, "utf8")
    if (body.length > MAX_SOURCE_BYTES) return { ok: false, reason: "oversize" }
    return { ok: true, body, contentType: response.headers.get("content-type") ?? "", status: response.status }
  }

  log("info", "Source rejected the plain fetch (anti-bot wall?) — retrying with a Chrome TLS fingerprint (curl-impersonate)...")
  const impersonated = await fetchImpersonated(url, log, timeoutMs)
  if (impersonated && impersonated.status > 0 && impersonated.status < 400 && impersonated.buffer.length <= MAX_SOURCE_BYTES) {
    if (!isChallengePage(impersonated.buffer.toString("utf8", 0, 60000))) {
      return { ok: true, body: impersonated.buffer, contentType: impersonated.contentType, status: impersonated.status }
    }
  } else if (!impersonated) {
    log("warn", "curl-impersonate retry failed")
  }

  // reCAPTCHA-gated page: extract the widget and solve it via the service.
  const challengedHtml = impersonated?.buffer.toString("utf8", 0, 60000) ?? text
  const widget = extractRecaptcha(challengedHtml)
  if (widget) {
    log("info", `reCAPTCHA ${widget.version} widget detected (sitekey ${widget.sitekey.slice(0, 8)}…) — solving...`)
    const token = await solveRecaptcha(widget, url, log)
    if (token) {
      const replay = recaptchaReplayHeaders(token)
      try {
        const retried = await fetch(url, {
          headers: {
            "User-Agent": generateUserAgent(),
            Accept: "text/html,application/xhtml+xml,application/pdf,*/*;q=0.8",
            ...replay.headers,
            cookie: replay.cookie,
          },
          redirect: "follow",
          signal: AbortSignal.timeout(timeoutMs),
        })
        const body = Buffer.from(await retried.arrayBuffer())
        if (retried.status < 400 && !isChallengePage(body.toString("utf8", 0, 60000))) {
          log("success", "reCAPTCHA solved — retry returned real content")
          return { ok: true, body, contentType: retried.headers.get("content-type") ?? "", status: retried.status }
        }
        log("warn", `replayed request still challenged (HTTP ${retried.status})`)
      } catch (error) {
        log("warn", `reCAPTCHA replay fetch failed: ${error instanceof Error ? error.message : "unknown error"}`)
      }
    }
  }

  // Last resort: scrape public proxies and retry through the pool.
  log("info", "Trying public proxy pool as a last resort...")
  for (let attempt = 0; attempt < MAX_PROXY_ATTEMPTS; attempt++) {
    const proxy = await acquireProxy(log)
    if (!proxy) {
      log("warn", "No public proxies available")
      break
    }
    const viaProxy = await fetchViaProxy(
      url,
      proxy,
      { "User-Agent": generateUserAgent(), Accept: "text/html,application/xhtml+xml,application/pdf,*/*;q=0.8" },
      10_000,
    )
    if (viaProxy && viaProxy.status < 400 && viaProxy.body.length <= MAX_SOURCE_BYTES) {
      if (!isChallengePage(viaProxy.body.toString("utf8", 0, 60000))) {
        log("success", `Proxy ${proxy} delivered real content`)
        return { ok: true, body: viaProxy.body, contentType: viaProxy.contentType, status: viaProxy.status }
      }
      log("warn", `Proxy ${proxy} returned another challenge shell`)
    } else {
      log("warn", `Proxy ${proxy} failed (${viaProxy ? `HTTP ${viaProxy.status}` : "timeout/refused"})`)
    }
  }

  log("warn", "The challenge did not resolve via TLS fingerprint, CAPTCHA solve, or public proxies")
  return { ok: false, reason: "challenge" }
}

function looksLikeDocument(buffer: Buffer, extension: PublicDocumentExtension): boolean {
  if (extension === "pdf") return buffer.subarray(0, 5).toString("ascii") === "%PDF-"
  if (buffer.subarray(0, 4).toString("hex") === "d0cf11e0") return extension === "ppt"
  return buffer.subarray(0, 2).toString("ascii") === "PK"
}

function countPages(buffer: Buffer, extension: PublicDocumentExtension): number {
  if (extension === "pdf") {
    const count = (buffer.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length
    return Math.max(count, 1)
  }
  const names = buffer.toString("latin1").match(/ppt\/slides\/slide\d+\.xml/g) ?? []
  return Math.max(new Set(names).size, 1)
}

function outputFormat(extension: PublicDocumentExtension): OutputFormat | null {
  if (extension === "pdf") return "pdf"
  if (extension === "pptx") return "pptx"
  return null
}

export async function fetchPublicDocument(
  candidate: PublicDocumentCandidate,
  log: Logger,
): Promise<{ buffer: Buffer; extension: PublicDocumentExtension } | null> {
  try {
    const fetched = await fetchWithImpersonationFallback(candidate.url, log)
    if (!fetched.ok || (fetched.status !== 0 && fetched.status >= 400)) {
      log("warn", `Public document candidate failed: ${fetched.ok ? `HTTP ${fetched.status}` : fetched.reason}`)
      return null
    }
    const extension = extensionFromUrl(candidate.url, fetched.contentType) ?? candidate.extension
    const buffer = fetched.body
    if (!looksLikeDocument(buffer, extension)) {
      log("warn", "Candidate did not return a recognizable PDF or PowerPoint file")
      return null
    }
    return { buffer, extension }
  } catch (error) {
    log("warn", `Public document fetch failed: ${error instanceof Error ? error.message : "unknown error"}`)
    return null
  }
}

export async function downloadPublicDocument(
  url: string,
  log: Logger,
  progress: ProgressReporter,
  options: DownloadOptions,
  pageHtml?: string,
): Promise<{ result?: PublicDocumentResult; error?: string }> {
  let sourceUrl = url
  let title = "Public document"
  let candidates: PublicDocumentCandidate[] = []

  const directExtension = extensionFromUrl(url)
  if (!directExtension) {
    try {
      log("step", "Inspecting page markup for public document assets...")
      let html = pageHtml
      if (!html) {
        const fetched = await fetchWithImpersonationFallback(url, log)
        if (!fetched.ok) {
          return {
            error:
              fetched.reason === "challenge"
                ? "This site is protected by an anti-bot challenge (Cloudflare, reCAPTCHA, or similar) that did not resolve via TLS fingerprint, CAPTCHA solving, or the public proxy pool. Configure CAPTCHA_API_KEY to enable reCAPTCHA solving."
                : "The source page could not be fetched from this server's network.",
          }
        }
        html = fetched.body.toString("utf8")
      }
      title = extractPageTitle(html, new URL(url).hostname)
      candidates = extractPublicDocumentCandidates(html, url)
      if (candidates.length === 0) {
        return { error: "No public PDF, PPT, or PPTX asset was found in the page markup." }
      }
      log("info", `Found ${candidates.length} public document candidate${candidates.length === 1 ? "" : "s"}`)
    } catch (error) {
      return { error: `Could not inspect the source page: ${error instanceof Error ? error.message : "unknown error"}` }
    }
  } else {
    candidates = [{ url, extension: directExtension, score: 0 }]
    try {
      title = new URL(url).pathname.split("/").pop()?.replace(/\.(pdf|pptx?)$/i, "") || title
    } catch {
      // Keep fallback title.
    }
  }

  let fetched: { buffer: Buffer; extension: PublicDocumentExtension } | null = null
  for (const candidate of candidates) {
    log("info", `Trying public ${candidate.extension.toUpperCase()} asset...`)
    fetched = await fetchPublicDocument(candidate, log)
    if (fetched) {
      sourceUrl = candidate.url
      break
    }
  }
  if (!fetched) return { error: "The page exposed document links, but none returned a valid public file." }

  const format = outputFormat(fetched.extension)
  if (!format) {
    return { error: "Legacy .ppt files are not converted automatically. Provide a public .pptx or PDF source instead." }
  }

  progress(1, 1, "Public document ready")
  const size = `${(fetched.buffer.length / 1024 / 1024).toFixed(1)} MB`
  const pages = countPages(fetched.buffer, fetched.extension)
  log("success", `Original ${format.toUpperCase()} preserved: ${size}`)
  const delivery = await storeForDownload(fetched.buffer, title, format, options, log, {
    sourceUrl: url,
    title,
    pages,
    size,
    format,
    platform: "public",
    textSelectable: true,
  })
  if ("error" in delivery) return delivery

  return {
    result: {
      id: delivery.id,
      title,
      pages,
      size,
      format,
      platform: "public",
      textSelectable: true,
      sourceUrl,
      cachedUrl: delivery.cachedUrl,
      cachedExpiresAt: delivery.cachedExpiresAt,
      catboxUrl: delivery.catboxUrl,
      catboxExpiresAt: delivery.catboxExpiresAt,
      fileBase64: delivery.fileBase64,
    },
  }
}
