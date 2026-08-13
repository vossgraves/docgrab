import { get, put } from "@vercel/blob"
import crypto from "node:crypto"
import type { FileExt } from "./store"
import type { Logger, OutputFormat, Platform } from "./types"

export const CACHE_TTL_SECONDS = 12 * 60 * 60
const CACHE_PREFIX = "docgrab-cache/v1"

export interface CacheMetadata {
  sourceUrl: string
  title: string
  pages: number
  size: string
  format: OutputFormat
  platform: Platform
  textSelectable?: boolean
}

interface CacheRecord extends CacheMetadata {
  createdAt: number
  pathname: string
  cachedUrl: string
}

export interface CachedDocument extends CacheMetadata {
  id: string
  cachedUrl: string
  cachedExpiresAt: number
  cacheHit: true
}

function storeId(): string | undefined {
  return process.env.CACHE_BLOB_STORE_ID || undefined
}

function keyFor(sourceUrl: string, format: OutputFormat): string {
  return crypto.createHash("sha256").update(`${sourceUrl}\n${format}`).digest("hex")
}

function metadataPathFor(sourceUrl: string, format: OutputFormat): string {
  return `${CACHE_PREFIX}/${keyFor(sourceUrl, format)}.json`
}

function expiresAt(createdAt: number): number {
  return createdAt + CACHE_TTL_SECONDS * 1000
}

/** Return a cache hit only when a complete, still-fresh metadata record exists. */
export async function getCachedDocument(sourceUrl: string, format: OutputFormat, log: Logger): Promise<CachedDocument | null> {
  const id = storeId()
  if (!id) return null

  try {
    const metadataResponse = await get(metadataPathFor(sourceUrl, format), {
      access: "public",
      storeId: id,
      // The index is overwritten when a 12-hour entry is refreshed. Always read
      // its origin version so an old CDN copy cannot extend the cache lifetime.
      useCache: false,
    })
    if (!metadataResponse || metadataResponse.statusCode !== 200) return null

    const raw = await new Response(metadataResponse.stream).text()
    const record = JSON.parse(raw) as CacheRecord
    if (record.sourceUrl !== sourceUrl || record.format !== format || !record.cachedUrl || expiresAt(record.createdAt) <= Date.now()) {
      return null
    }

    log("success", `12-hour cache hit: reusing the existing ${format.toUpperCase()} without rebuilding it`)
    return {
      ...record,
      id: `cache_${keyFor(sourceUrl, format)}`,
      cachedExpiresAt: expiresAt(record.createdAt),
      cacheHit: true,
    }
  } catch (error) {
    // A missing or temporarily unavailable cache must never block a fresh public download.
    const message = error instanceof Error ? error.message : String(error)
    if (!/not found|404|missing/i.test(message)) log("warn", `Cache lookup skipped: ${message}`)
    return null
  }
}

/** Persist a generated file and an authoritative metadata index in public Blob storage. */
export async function putCachedDocument(
  buffer: Buffer,
  title: string,
  ext: FileExt,
  metadata: CacheMetadata,
  log: Logger,
): Promise<{ cachedUrl?: string; cachedExpiresAt?: number }> {
  const id = storeId()
  if (!id) return {}

  const key = keyFor(metadata.sourceUrl, metadata.format)
  const createdAt = Date.now()
  const pathname = `${CACHE_PREFIX}/${key}/${createdAt}-${crypto.randomBytes(4).toString("hex")}.${ext}`
  const contentType = ext === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  const fileOptions = {
    access: "public" as const,
    storeId: id,
    cacheControlMaxAge: CACHE_TTL_SECONDS,
    addRandomSuffix: false,
    allowOverwrite: false,
  }

  try {
    const file = await put(pathname, buffer, {
      ...fileOptions,
      contentType,
      multipart: buffer.length > 4 * 1024 * 1024,
    })

    const record: CacheRecord = {
      ...metadata,
      createdAt,
      pathname: file.pathname,
      cachedUrl: file.downloadUrl,
    }
    await put(metadataPathFor(metadata.sourceUrl, metadata.format), JSON.stringify(record), {
      access: "public",
      storeId: id,
      // The index must be refreshed immediately when the 12-hour record rolls over.
      cacheControlMaxAge: 60,
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json; charset=utf-8",
    })

    log("success", `Cached ${ext.toUpperCase()} in Vercel Blob for 12 hours`)
    return {
      cachedUrl: file.downloadUrl,
      cachedExpiresAt: expiresAt(createdAt),
    }
  } catch (error) {
    // A cache failure should fall back to the existing inline/Catbox delivery path.
    log("warn", `Vercel Blob cache unavailable; continuing with normal delivery (${error instanceof Error ? error.message : String(error)})`)
    return {}
  }
}
