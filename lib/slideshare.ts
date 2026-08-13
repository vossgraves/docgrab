import { buildPdfFromJpegs, isJpeg } from "./pdf"
import { buildPptxFromJpegs } from "./pptx"
import { storeForDownload } from "./delivery"
import { fetchHtmlWithBrowser } from "./browser"
import { getUserAgent } from "./user-agent"
import { webpToJpeg } from "./webp"
import { downloadPublicDocument } from "./public-document"
import type { Logger, ProgressReporter, DownloadOptions, OutputFormat } from "./types"

const IMAGE_CONCURRENCY = 8
const IMAGE_RETRIES = 2
const IMAGE_TIMEOUT_MS = 8000
const IMAGE_PROBE_TIMEOUT_MS = 9000

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

async function fetchTextWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 30000,
): Promise<{ response: Response; text: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    const text = await response.text()
    return { response, text }
  } finally {
    clearTimeout(timer)
  }
}

async function fetchBytesWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 30000,
): Promise<{ response: Response; bytes: Buffer }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    const bytes = Buffer.from(await response.arrayBuffer())
    return { response, bytes }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * SlideShare can return a client challenge to serverless IPs even when the
 * public page is available to ordinary browsers. The public HTML reader is
 * used only as a fallback and only accepted when it exposes real slide CDN
 * URLs; it does not click controls or bypass authentication.
 */
async function fetchPageViaPublicReader(url: string, log: Logger): Promise<string | null> {
  const target = url.replace(/^https?:\/\//i, "")
  const readerUrl = `https://r.jina.ai/http://${target}`
  try {
    log("info", "Direct page was challenge-gated; trying the public HTML reader...")
    const { response: resp, text } = await fetchTextWithTimeout(readerUrl, { headers: { Accept: "text/plain,text/html" } }, 15000)
    if (!resp.ok) return null
    if (text.length > 1000 && /image\.slidesharecdn\.com\//i.test(text)) {
      log("success", "Public HTML reader returned slide assets")
      return text
    }
  } catch {
    // Continue to the normal browser fallback below.
  }
  return null
}

/**
 * Fetch SlideShare HTML through the fast direct path first. SlideShare sometimes
 * returns a small challenge/app shell to non-browser clients that is large
 * enough to look valid but contains none of the slide assets. In that case,
 * fall back to browser rendering so public decks are not falsely reported as
 * private or invalid. Real asset-bearing pages still avoid the browser startup.
 */
async function fetchPageHtml(url: string, log: Logger): Promise<string | null> {
  try {
    log("info", "Fetching page directly...")
    const { response: resp, text: html } = await fetchTextWithTimeout(url, { headers: { "User-Agent": getUserAgent(), Accept: "text/html" } }, 10000)
    if (resp.ok) {
      const hasSlideAssets = /image\.slidesharecdn\.com\//i.test(html) || /slidesharecdn\.com\//i.test(html)
      if (html.length > 1000 && hasSlideAssets) {
        log("success", "Direct fetch returned public page HTML with slide assets")
        return html
      }
      if (html.length > 1000) {
        log("info", "Direct response contains no slide assets; switching to browser rendering...")
      } else {
        log("warn", "Direct fetch returned an empty or incomplete page")
      }
    } else {
      log("warn", `Direct fetch returned HTTP ${resp.status}`)
    }
  } catch {
    log("warn", "Direct fetch failed")
  }

  const readerHtml = await fetchPageViaPublicReader(url, log)
  if (readerHtml) return readerHtml

  log("step", "Falling back to normal headless browser rendering...")
  const browserHtml = await fetchHtmlWithBrowser(
    url,
    log,
    35000,
    'img[src*="slidesharecdn.com"], img[data-src*="slidesharecdn.com"], source[srcset*="slidesharecdn.com"], [data-slide-image*="slidesharecdn.com"]',
    8000,
  )
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
  /** Exact size/quality pairs exposed by the public page, in first-seen order. */
  observedVariants: Array<{ dir: string; size: number }>
}

function extractSlideInfo(html: string): SlideInfo | null {
  const pageNums = new Set<number>()
  const qualityDirs = new Set<string>()
  const sizes = new Set<number>()
  const observedVariants: Array<{ dir: string; size: number }> = []
  const observedVariantKeys = new Set<string>()
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
      const dir = m[2]
      const size = Number.parseInt(m[5], 10)
      qualityDirs.add(dir)
      pageNums.add(Number.parseInt(m[4], 10))
      sizes.add(size)
      const variantKey = `${dir}:${size}`
      if (!observedVariantKeys.has(variantKey)) {
        observedVariantKeys.add(variantKey)
        observedVariants.push({ dir, size })
      }
    }
  }

  if (!baseUrl || !titleSlug || pageNums.size === 0) return null
  return {
    baseUrl,
    titleSlug,
    maxPage: Math.max(...pageNums),
    qualityDirs: [...qualityDirs],
    maxSeenSize: sizes.size > 0 ? Math.max(...sizes) : 0,
    observedVariants: observedVariants.sort((a, b) => b.size - a.size),
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
  const seen = new Set<string>()
  const add = (dir: string, size: number) => {
    const url = `${info.baseUrl}/${dir}/${info.titleSlug}-${pageNum}-${size}.jpg`
    if (!seen.has(url)) {
      seen.add(url)
      candidates.push(url)
    }
  }

  // Probe exact pairs observed in the public HTML first. This avoids spending
  // the probe budget on synthesized high-resolution paths that the CDN may
  // not serve to serverless fetchers while retaining the best available
  // public asset when it is present.
  for (const variant of info.observedVariants) add(variant.dir, variant.size)
  for (const size of SIZES) {
    for (const dir of dirs) add(dir, size)
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
async function fetchJpeg(
  url: string,
  trace?: (reason: string) => void,
  timeoutMs = IMAGE_TIMEOUT_MS,
  retryCount = IMAGE_RETRIES,
): Promise<Buffer | null> {
  for (let attempt = 0; attempt <= retryCount; attempt++) {
    try {
      const { response: resp, bytes: buf } = await fetchBytesWithTimeout(url, { headers: { "User-Agent": getUserAgent(), Accept: "image/jpeg,image/*" } }, timeoutMs)
      if (resp.ok) {
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
      if (attempt < retryCount) {
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
  const candidates = buildCandidates(info, 1)
  const results: Array<{ index: number; url: string; buffer: Buffer }> = []
  let next = 0
  const probe = async () => {
    while (next < candidates.length) {
      const index = next++
      const url = candidates[index]
      const variant = url.match(/\/(\d+)\/.+-1-(\d+)\.jpg$/)
      const label = variant ? `${variant[2]}px (/${variant[1]}/)` : url
      const buffer = await fetchJpeg(
        url,
        (reason) => {
          // Plain 404s just mean the CDN never generated that variant — not a failure.
          if (reason !== "HTTP 404") log("warn", `Variant ${label} unavailable: ${reason}`)
        },
        IMAGE_PROBE_TIMEOUT_MS,
        0,
      )
      if (buffer) results.push({ index, url, buffer })
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, candidates.length) }, () => probe()))

  // Candidate order is largest size first, then best quality directory. All probes
  // run concurrently, but selection remains deterministic and prefers the best result.
  const winner = results.sort((a, b) => a.index - b.index)[0]
  if (!winner) return null
  const variant = winner.url.match(/\/(\d+)\/.+-1-(\d+)\.jpg$/)
  const dir = variant ? variant[1] : QUALITY_DIRS[0]
  const size = variant ? Number.parseInt(variant[2], 10) : SIZES[0]
  log("success", `Best available quality: ${size}px (quality dir /${dir}/)`)
  return { dir, size, firstPage: winner.buffer }
}

/** Download a single slide at the resolved best variant, falling back to smaller sizes only if needed. */
async function downloadSlide(info: SlideInfo, pageNum: number, bestDir: string, bestSize: number): Promise<Buffer | null> {
  // Try the resolved best variant first.
  const primary = `${info.baseUrl}/${bestDir}/${info.titleSlug}-${pageNum}-${bestSize}.jpg`
  const buf = await fetchJpeg(primary)
  if (buf) return buf

  // Rare per-page miss: fall back through the selected size and smaller variants.
  // Avoid probing larger, slower variants after a deck-wide fast variant was chosen.
  for (const url of buildCandidates(info, pageNum)) {
    const variant = url.match(/\/(\d+)\/.+-(\d+)\.jpg$/)
    if (url === primary || (variant && Number.parseInt(variant[2], 10) > bestSize)) continue
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

  const delivery = await storeForDownload(fileBuffer, title, options.format, options, log)
  if ("error" in delivery) return delivery
  log("success", `${options.format.toUpperCase()} stored and ready for download`)

  return {
    result: {
      id: delivery.id,
      title,
      pages: jpegs.length,
      size: sizeMb,
      format: options.format,
      catboxUrl: delivery.catboxUrl,
      catboxExpiresAt: delivery.catboxExpiresAt,
      textSelectable: false,
      fileBase64: delivery.fileBase64,
    },
  }
}
