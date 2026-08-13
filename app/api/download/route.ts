import type { NextRequest } from "next/server"
import { downloadSlideshare } from "@/lib/slideshare"
import { downloadScribd } from "@/lib/scribd"
import { assertPublicUrl, downloadPublicDocument } from "@/lib/public-document"
import { checkRateLimit, getClientKey } from "@/lib/rate-limit"
import { registerDownload } from "@/lib/user-agent"
import { getCachedDocument } from "@/lib/blob-cache"
import type { StreamEvent, Logger, ProgressReporter, DownloadOptions, OutputFormat, Platform } from "@/lib/types"

export const runtime = "nodejs"
export const maxDuration = 300
export const dynamic = "force-dynamic"

function normalizeUrl(raw: string): string | null {
  let url = raw.trim()
  if (!url) return null
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null
    return parsed.toString()
  } catch {
    return null
  }
}

function detectPlatform(url: string): Platform {
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (host === "slideshare.net" || host.endsWith(".slideshare.net")) return "slideshare"
    if (host === "scribd.com" || host.endsWith(".scribd.com")) return "scribd"
  } catch {
    // normalizeUrl already validated the URL; retain the safe fallback below.
  }
  return "public"
}

export async function POST(request: NextRequest) {
  const limit = checkRateLimit(getClientKey(request.headers))
  if (!limit.allowed) {
    return Response.json(
      {
        error: `Rate limit reached. Try again in ${limit.retryAfterSeconds}s. (Max 5 downloads per 10 minutes.)`,
      },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    )
  }

  let body: { url?: string; format?: string; uploadToCatbox?: boolean; catboxUserhash?: string }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 })
  }

  const url = normalizeUrl(body.url ?? "")
  if (!url) return Response.json({ error: "No valid URL provided" }, { status: 400 })

  try {
    await assertPublicUrl(url)
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "The source URL is not publicly reachable." }, { status: 400 })
  }

  const platform = detectPlatform(url)
  const format: OutputFormat = body.format === "pptx" ? "pptx" : "pdf"
  const userhash = typeof body.catboxUserhash === "string" ? body.catboxUserhash.trim() : ""
  const options: DownloadOptions = {
    format,
    uploadToCatbox: body.uploadToCatbox === true || userhash.length > 0,
    catboxUserhash: userhash || undefined,
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false
      const send = (event: StreamEvent) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        } catch {
          closed = true
        }
      }

      const log: Logger = (level, message) => send({ type: "log", level, message, timestamp: Date.now() })
      const progress: ProgressReporter = (current, total, label) => send({ type: "progress", current, total, label })

      try {
        log("info", `Platform detected: ${platform}`)
        log("info", `Target URL: ${url}`)
        registerDownload()

        // A user-requested Catbox upload has its own semantics, so it remains a
        // fresh generation. Ordinary requests can reuse the immutable 12-hour
        // Blob result before touching SlideShare, Scribd, or the source page.
        if (!options.uploadToCatbox) {
          const cached = await getCachedDocument(url, format, log)
          if (cached) {
            send({
              type: "result",
              id: cached.id,
              title: cached.title,
              pages: cached.pages,
              size: cached.size,
              platform,
              format: cached.format,
              textSelectable: cached.textSelectable,
              sourceUrl: cached.sourceUrl,
              cachedUrl: cached.cachedUrl,
              cachedExpiresAt: cached.cachedExpiresAt,
              cacheHit: true,
            })
            return
          }
        }

        const outcome =
          platform === "slideshare"
            ? await downloadSlideshare(url, log, progress, options)
            : platform === "scribd"
              ? await downloadScribd(url, log, progress, options)
              : await downloadPublicDocument(url, log, progress, options)

        if (outcome.error || !outcome.result) {
          log("error", outcome.error ?? "Unknown failure")
          send({ type: "error", message: outcome.error ?? "Unknown failure" })
        } else {
          send({ type: "result", ...outcome.result, platform })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unexpected server error"
        send({ type: "log", level: "error", message, timestamp: Date.now() })
        send({ type: "error", message })
      } finally {
        closed = true
        try {
          controller.close()
        } catch {
          // already closed
        }
      }
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  })
}
