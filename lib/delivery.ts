import { uploadToCatbox } from "./catbox"
import { putCachedDocument, type CacheMetadata } from "./blob-cache"
import { saveFile, slugify, type FileExt } from "./store"
import type { DownloadOptions, Logger } from "./types"

/** Keep small generated files in the streamed response for instant client-side download. */
export const INLINE_FILE_LIMIT_BYTES = 3_000_000

export interface StoredDelivery {
  id: string
  cachedUrl?: string
  cachedExpiresAt?: number
  catboxUrl?: string
  catboxExpiresAt?: number
  fileBase64?: string
}

/**
 * Store a generated file and make sure it remains downloadable across Vercel
 * invocations. Vercel Blob is the preferred 12-hour cache; Catbox remains an
 * explicit-share option and a fallback when Blob is not configured or fails.
 */
export async function storeForDownload(
  buffer: Buffer,
  title: string,
  ext: FileExt,
  options: DownloadOptions,
  log: Logger,
  cacheMetadata?: CacheMetadata,
): Promise<StoredDelivery | { error: string }> {
  const id = await saveFile(buffer, title, ext)
  const cached = cacheMetadata ? await putCachedDocument(buffer, title, ext, cacheMetadata, log) : {}

  // Large files need an external URL only when Blob did not provide one. An
  // explicit Catbox request always remains honored for users who want a second
  // share link or their own Catbox retention policy.
  const requiresCatbox = options.uploadToCatbox || (buffer.length > INLINE_FILE_LIMIT_BYTES && !cached.cachedUrl)
  let catboxUrl: string | undefined
  let catboxExpiresAt: number | undefined

  if (requiresCatbox) {
    const contentType = ext === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    const uploaded = await uploadToCatbox(buffer, `${slugify(title)}.${ext}`, contentType, log, options.catboxUserhash)
    catboxUrl = uploaded.url
    catboxExpiresAt = uploaded.expiresAt
    if (!catboxUrl && !cached.cachedUrl) {
      return {
        error:
          uploaded.error ??
          "The generated file is too large for an inline download, and durable external delivery was unavailable. Please retry.",
      }
    }
  }

  return {
    id,
    cachedUrl: cached.cachedUrl,
    cachedExpiresAt: cached.cachedExpiresAt,
    catboxUrl,
    catboxExpiresAt,
    fileBase64: buffer.length <= INLINE_FILE_LIMIT_BYTES ? buffer.toString("base64") : undefined,
  }
}
