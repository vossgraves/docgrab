import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { storeForDownload } from "./delivery"
import { getUserAgent } from "./user-agent"
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

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = SOURCE_TIMEOUT_MS): Promise<Response> {
  await assertPublicUrl(url)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "User-Agent": getUserAgent(),
        Accept: "application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.ms-powerpoint,*/*;q=0.8",
        ...(init.headers ?? {}),
      },
    })
  } finally {
    clearTimeout(timer)
  }
}

async function readResponseBuffer(response: Response): Promise<Buffer> {
  const advertised = Number(response.headers.get("content-length") ?? "0")
  if (advertised > MAX_SOURCE_BYTES) throw new Error("The public document is larger than the 200 MB server limit.")
  if (!response.body) return Buffer.from(await response.arrayBuffer())

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > MAX_SOURCE_BYTES) {
      await reader.cancel()
      throw new Error("The public document is larger than the 200 MB server limit.")
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks, total)
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
    const response = await fetchWithTimeout(candidate.url)
    if (!response.ok) {
      log("warn", `Public document candidate returned HTTP ${response.status}`)
      return null
    }
    const extension = extensionFromUrl(candidate.url, response.headers.get("content-type") ?? "") ?? candidate.extension
    const buffer = await readResponseBuffer(response)
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
        const response = await fetchWithTimeout(url, { headers: { Accept: "text/html,application/xhtml+xml" } })
        if (!response.ok) return { error: `Source page returned HTTP ${response.status}.` }
        html = await response.text()
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
  log("success", `Original ${format.toUpperCase()} preserved: ${size}`)
  const delivery = await storeForDownload(fetched.buffer, title, format, options, log)
  if ("error" in delivery) return delivery

  return {
    result: {
      id: delivery.id,
      title,
      pages: countPages(fetched.buffer, fetched.extension),
      size,
      format,
      platform: "public",
      textSelectable: true,
      sourceUrl,
      catboxUrl: delivery.catboxUrl,
      catboxExpiresAt: delivery.catboxExpiresAt,
      fileBase64: delivery.fileBase64,
    },
  }
}
