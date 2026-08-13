import { uploadToCatbox } from "./catbox"
import { saveFile, slugify, type FileExt } from "./store"
import type { DownloadOptions, Logger } from "./types"

/** Keep small generated files in the streamed response for instant client-side download. */
export const INLINE_FILE_LIMIT_BYTES = 3_000_000

export interface StoredDelivery {
  id: string
  catboxUrl?: string
  catboxExpiresAt?: number
  fileBase64?: string
}

/**
 * Store a generated file and make sure large files have a durable download URL.
 * Vercel's function /tmp directory is instance-local, so large files cannot rely
 * on a later request to /api/file/:id. Anonymous litterbox storage is used only
 * when the file is too large to inline or the user explicitly requests sharing.
 */
export async function storeForDownload(
  buffer: Buffer,
  title: string,
  ext: FileExt,
  options: DownloadOptions,
  log: Logger,
): Promise<StoredDelivery | { error: string }> {
  const id = await saveFile(buffer, title, ext)
  const requiresExternal = options.uploadToCatbox || buffer.length > INLINE_FILE_LIMIT_BYTES
  let catboxUrl: string | undefined
  let catboxExpiresAt: number | undefined

  if (requiresExternal) {
    const contentType = ext === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    const uploaded = await uploadToCatbox(buffer, `${slugify(title)}.${ext}`, contentType, log, options.catboxUserhash)
    catboxUrl = uploaded.url
    catboxExpiresAt = uploaded.expiresAt
    if (!catboxUrl) {
      return {
        error:
          uploaded.error ??
          "The generated file is too large for an inline download, and temporary external delivery was unavailable. Please retry.",
      }
    }
  }

  return {
    id,
    catboxUrl,
    catboxExpiresAt,
    fileBase64: buffer.length <= INLINE_FILE_LIMIT_BYTES ? buffer.toString("base64") : undefined,
  }
}
