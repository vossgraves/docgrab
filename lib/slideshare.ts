import { buildPdfFromJpegs, isJpeg } from "./pdf"
import { buildPptxFromJpegs } from "./pptx"
import { saveFile } from "./store"
import { uploadToCatbox } from "./catbox"
import { fetchHtmlWithBrowser } from "./browser"
import { slugify } from "./store"
import { getUserAgent } from "./user-agent"
import { webpToJpeg } from "./webp"
import { downloadPublicDocument } from "./public-document"
import type { Logger, ProgressReporter, DownloadOptions, OutputFormat } from "./types"

const IMAGE_CONCURRENCY = 8
const IMAGE_RETRIES = 2

interface SlideshareResult {
  id: string
  title: string
  pages: number
  size: string
  format: OutputFormat
  catboxUrl?: string
  catboxExpiresAt?: number
  fileBase64?: string
  textSelectable?: boolean
  sourceUrl?: string
}

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 30000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** Fetch the SlideShare page HTML using direct fetch, then normal browser rendering. */
async function fetchPageHtml(url: string, log: Logger): Promise<string | null> {
  try {
    log("info", "Fetching page directly...")
    const resp = await fetchWithTimeout(url, { headers: { "User-Agent": getUserAgent(), Accept: "text/html" } }, 20000)
    if (resp.ok) {
      const html = await resp.text()
      if (html.length > 1000) {
        log("success", "Direct fetch returned public page HTML")
        return html
      }
      log("warn", "Direct fetch returned an empty or incomplete page")
    } else {
      log("warn", `Direct fetch returned HTTP ${resp.status}`)
    }
  } catch {
    log("warn", "Direct fetch failed")
  }

  log("step", "Falling back to normal headless browser rendering...")
  const browserHtml = await fetchHtmlWithBrowser(url, log)
  if (browserHtml && browserHtml.length > 1000) {
    log("success", "Headless browser retrieved public page HTML")
    return browserHtml
  }
  if (browserHtml) log("warn", "Headless browser loaded an empty or incomplete page")
  return null
}

interface SlideInfo {
  baseUrl: string
  titleSlug: string
  maxPage: number
  /** Quality directories (e.g. "75", "85") actually seen in the page HTML. */
  qualityDirs: string[]
  /** Largest image width (e.g. 2048) actually seen in the page HTML. */
  maxSeenSize: number
}

function extractSlideInfo(html: string): SlideInfo | null {
  const pageNums = new Set<number>()
  const qualityDirs = new Set<string>()
  const sizes = new Set<number>()
  let baseUrl: string | null = null
  let titleSlug: string | null = null

  const urls = html.match(/https:\/\/image\.slidesharecdn\.com\/[^"'<>\s)\]]+/g) ?? []
  for (const raw of urls) {
    const clean = raw.split("?")[0]
    const m = clean.match(/(https:\/\/image\.slidesharecdn\.com\/[^/]+)\/(\d+)\/(.+)-(\d+)-(\d+)\.jpg/)
    if (m) {
      if (!baseUrl) {
        baseUrl = m[1]
        titleSlug = m[3]
      }
      qualityDirs.add(m[2])
      pageNums.add(Number.parseInt(m[4], 10))
      sizes.add(Number.parseInt(m[5], 10))
    }
  }

  if (!baseUrl || !titleSlug || pageNums.size === 0) return null
  return {
    baseUrl,
    titleSlug,
    maxPage: Math.max(...pageNums),
    qualityDirs: [...qualityDirs],
    maxSeenSize: sizes.size > 0 ? Math.max(...sizes) : 0,
  }
}

function extractTitle(html: string, fallbackSlug: string): string {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i)
  let title = m ? m[1].trim() : ""
  for (const suffix of [" | PPT", " - PowerPoint", " | PDF", " | SlideShare"]) {
    title = title.split(suffix)[0]
  }
  if (!title || title.toLowerCase().includes("challenge")) {
    title = fallbackSlug.replace(/-/g, " ")
  }
  return title
}

/** All known SlideShare CDN image widths, largest first. */
const SIZES = [2048, 1024, 768, 638, 320]
/** All known SlideShare CDN quality directories, best first. */
const QUALITY_DIRS = ["95", "85", "75"]

/**
 * Build candidate URL variants for one page, strictly ordered by resolution
 * (largest first), then by quality directory. Quality dirs actually seen in
 * the page HTML are probed before the generic ones at each size.
 */
function buildCandidates(info: SlideInfo, pageNum: number): string[] {
  const dirs = [...new Set([...info.qualityDirs, ...QUALITY_DIRS])]
  const candidates: string[] = []
  for (const size of SIZES) {
    for (const dir of dirs) {
      candidates.push(`${info.baseUrl}/${dir}/${info.titleSlug}-${pageNum}-${size}.jpg`)
    }
  }
  return candidates
}

/** RIFF....WEBP container magic check. */
function isWebp(buf: Buffer): boolean {
  return (
    buf.length > 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  )
}

/**
 * Fetch a slide image, returning JPEG bytes. The CDN serves the highest-res
 * (2048px) variants only as WebP regardless of the Accept header, so WebP
 * responses are transcoded to high-quality JPEG via a pure-WASM codec that
 * works identically on local and serverless runtimes (no native deps).
 *
 * `trace` (used only during the page-1 probe) reports why a candidate failed
 * so quality regressions are visible in the process log instead of silent.
 */
async function fetchJpeg(url: string, trace?: (reason: string) => void): Promise<Buffer | null> {
  for (let attempt = 0; attempt <= IMAGE_RETRIES; attempt++) {
    try {
      const resp = await fetchWithTimeout(url, { headers: { "User-Agent": getUserAgent(), Accept: "image/jpeg,image/*" } }, 20000)
      if (resp.ok) {
        const buf = Buffer.from(await resp.arrayBuffer())
        if (isJpeg(buf)) return buf
        if (isWebp(buf)) {
          const jpeg = await webpToJpeg(buf, 92)
          if (jpeg && isJpeg(jpeg)) return jpeg
          trace?.("webp transcode failed")
        } else {
          trace?.(`unrecognized image format (first bytes: ${buf.subarray(0, 4).toString("hex")})`)
        }
      } else {
        trace?.(`HTTP ${resp.status}`)
      }
      return null // non-OK or unsupported format: this variant doesn't exist, don't retry
    } catch (err) {
      // network error: retry with backoff
      if (attempt < IMAGE_RETRIES) {
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)))
      } else {
        trace?.(`network error: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  return null
}

/**
 * Probe page 1 across every size/quality combination to find the best variant
 * the CDN actually serves for this deck. Returns the winning URL template
 * parts so all remaining pages skip the probing entirely.
 */
async function resolveBestVariant(
  info: SlideInfo,
  log: Logger,
): Promise<{ dir: string; size: number; firstPage: Buffer } | null> {
  for (const url of buildCandidates(info, 1)) {
    const variant = url.match(/\/(\d+)\/.+-1-(\d+)\.jpg$/)
    const label = variant ? `${variant[2]}px (/${variant[1]}/)` : url
    const buf = await fetchJpeg(url, (reason) => {
      // Plain 404s just mean the CDN never generated that variant — not a failure.
      if (reason !== "HTTP 404") log("warn", `Variant ${label} unavailable: ${reason}`)
    })
    if (buf) {
      const dir = variant ? variant[1] : QUALITY_DIRS[0]
      const size = variant ? Number.parseInt(variant[2], 10) : SIZES[0]
      log("success", `Best available quality: ${size}px (quality dir /${dir}/)`)
      return { dir, size, firstPage: buf }
    }
  }
  return null
}

/** Download a single slide at the resolved best variant, falling back to smaller sizes only if needed. */
async function downloadSlide(info: SlideInfo, pageNum: number, bestDir: string, bestSize: number): Promise<Buffer | null> {
  // Try the resolved best variant first.
  const primary = `${info.baseUrl}/${bestDir}/${info.titleSlug}-${pageNum}-${bestSize}.jpg`
  const buf = await fetchJpeg(primary)
  if (buf) return buf

  // Rare per-page miss: fall back through remaining candidates for this page.
  for (const url of buildCandidates(info, pageNum)) {
    if (url === primary) continue
    const fallback = await fetchJpeg(url)
    if (fallback) return fallback
  }
  return null
}

/** Concurrency-limited parallel download of all slides at the best available quality, preserving order. */
async function downloadAllSlides(
  info: SlideInfo,
  log: Logger,
  progress: ProgressReporter,
): Promise<(Buffer | null)[]> {
  // Resolve the highest-quality variant the CDN serves for this deck (probes page 1).
  const best = await resolveBestVariant(info, log)
  if (!best) {
    log("warn", "Could not resolve any image variant for page 1")
    return new Array(info.maxPage).fill(null)
  }

  const results: (Buffer | null)[] = new Array(info.maxPage).fill(null)
  results[0] = best.firstPage
  let completed = 1
  progress(completed, info.maxPage, "Downloading slides")

  let next = 1 // page 1 already downloaded by the probe
  const worker = async () => {
    while (next < info.maxPage) {
      const idx = next++
      results[idx] = await downloadSlide(info, idx + 1, best.dir, best.size)
      completed++
      progress(completed, info.maxPage, "Downloading slides")
    }
  }

  const workers = Array.from({ length: Math.min(IMAGE_CONCURRENCY, Math.max(info.maxPage - 1, 1)) }, () => worker())
  await Promise.all(workers)

  const failed = results.filter((r) => r === null).length
  if (failed > 0) {
    log("warn", `${failed} of ${info.maxPage} slides could not be downloaded`)
  }
  return results
}

export async function downloadSlideshare(
  url: string,
  log: Logger,
  progress: ProgressReporter,
  options: DownloadOptions = { format: "pdf", uploadToCatbox: false },
): Promise<{ result?: SlideshareResult; error?: string }> {
  log("step", `Starting SlideShare pipeline (output: ${options.format.toUpperCase()})`)

  const html = await fetchPageHtml(url, log)
  if (!html) {
    return { error: "Failed to fetch the SlideShare page after all attempts. Try again in a moment." }
  }

  // Prefer a publicly exposed original PDF/PPTX when the source page provides one.
  // This keeps source text/editable objects intact; image assembly remains the
  // fallback for decks that expose only rendered slide images.
  const original = await downloadPublicDocument(url, log, progress, options, html)
  if (original.result) {
    log("success", "Using the public original file instead of rasterizing slides")
    return original
  }
  if (original.error) log("info", `No public original export found: ${original.error}`)

  log("info", "Parsing HTML for slide image CDN references...")
  const info = extractSlideInfo(html)
  if (!info) {
    return { error: "Could not find slide images on the page. The URL may be invalid or the deck is private." }
  }
  log("success", `Found deck "${info.titleSlug}" with ${info.maxPage} slides`)

  const title = extractTitle(html, info.titleSlug)
  log("info", `Resolved title: ${title}`)

  log("step", `Downloading ${info.maxPage} slides (${IMAGE_CONCURRENCY} parallel connections)...`)
  const slides = await downloadAllSlides(info, log, progress)
  const jpegs = slides.filter((s): s is Buffer => s !== null)

  if (jpegs.length === 0) {
    return { error: "Failed to download any slide images from the CDN." }
  }
  log("success", `Downloaded ${jpegs.length} slides successfully`)

  let fileBuffer: Buffer | null
  if (options.format === "pptx") {
    log("step", "Assembling PPTX presentation...")
    fileBuffer = await buildPptxFromJpegs(jpegs)
    if (!fileBuffer) {
      return { error: "Failed to build PPTX from downloaded slides." }
    }
  } else {
    log("step", "Assembling PDF document...")
    fileBuffer = buildPdfFromJpegs(jpegs)
    if (!fileBuffer) {
      return { error: "Failed to build PDF from downloaded slides." }
    }
  }
  const sizeMb = `${(fileBuffer.length / 1024 / 1024).toFixed(1)} MB`
  log("success", `${options.format.toUpperCase()} built: ${sizeMb}, ${jpegs.length} pages`)

  const id = await saveFile(fileBuffer, title, options.format)
  log("success", `${options.format.toUpperCase()} stored and ready for download`)

  let catboxUrl: string | undefined
  let catboxExpiresAt: number | undefined
  if (options.uploadToCatbox) {
    const contentType =
      options.format === "pptx"
        ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        : "application/pdf"
    const uploaded = await uploadToCatbox(fileBuffer, `${slugify(title)}.${options.format}`, contentType, log, options.catboxUserhash)
    catboxUrl = uploaded.url
    catboxExpiresAt = uploaded.expiresAt
  }

  return {
    result: {
      id,
      title,
      pages: jpegs.length,
      size: sizeMb,
      format: options.format,
      catboxUrl,
      catboxExpiresAt,
      textSelectable: false,
      fileBase64: fileBuffer.length <= 3_000_000 ? fileBuffer.toString("base64") : undefined,
    },
  }
}
