import type { Logger } from "./types"

// catbox.moe rejects uploads larger than 200 MB; litterbox allows up to 1 GB.
export const CATBOX_LIMIT_BYTES = 200 * 1024 * 1024
export const LITTERBOX_LIMIT_BYTES = 1024 * 1024 * 1024

const CATBOX_API = "https://catbox.moe/user/api.php"
const LITTERBOX_API = "https://litterbox.catbox.moe/resources/internals/api.php"
const LITTERBOX_HOURS = 72

export interface CatboxResult {
  url?: string
  /** Set when the file was stored on litterbox (temporary, anonymous). */
  expiresAt?: number
  error?: string
}

async function postForm(api: string, form: FormData, timeoutMs: number): Promise<{ status: number; text: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(api, { method: "POST", body: form, signal: controller.signal })
    return { status: resp.status, text: (await resp.text()).trim() }
  } finally {
    clearTimeout(timer)
  }
}

function isCatboxUrl(text: string): boolean {
  return /^https?:\/\/(files\.|litter\.)?catbox\.moe\/\S+$/i.test(text)
}

/**
 * Upload a file for host-free storage.
 *
 * Strategy (mirrors how the CatboxUploadButton Discord plugin works, adapted
 * for servers): catbox.moe now rejects anonymous uploads from datacenter IPs
 * ("Invalid uploader"), so a userhash gives permanent catbox storage, and
 * without one we fall back to litterbox — catbox's anonymous sibling — which
 * stores files for 72 hours with no account needed.
 */
export async function uploadToCatbox(
  buffer: Buffer,
  fileName: string,
  contentType: string,
  log: Logger,
  userhashArg?: string,
): Promise<CatboxResult> {
  const sizeMb = buffer.length / 1024 / 1024
  // A userhash entered per-request takes priority over the server env var.
  const userhash = userhashArg?.trim() || process.env.CATBOX_USERHASH?.trim()

  const limit = userhash ? CATBOX_LIMIT_BYTES : LITTERBOX_LIMIT_BYTES
  if (buffer.length > limit) {
    const msg = `File is ${sizeMb.toFixed(1)} MB, over the ${userhash ? "catbox.moe 200 MB" : "litterbox 1 GB"} limit — upload skipped`
    log("error", msg)
    return { error: msg }
  }

  const file = new File([new Blob([new Uint8Array(buffer)], { type: contentType })], fileName)

  // Tier 1: permanent catbox.moe storage (requires account userhash)
  if (userhash) {
    log("step", `Uploading ${sizeMb.toFixed(1)} MB to catbox.moe (permanent)...`)
    try {
      const form = new FormData()
      form.append("reqtype", "fileupload")
      form.append("userhash", userhash)
      form.append("fileToUpload", file)

      const { status, text } = await postForm(CATBOX_API, form, 120000)
      if (status === 200 && isCatboxUrl(text)) {
        log("success", `Uploaded to catbox.moe: ${text}`)
        return { url: text }
      }
      log("warn", `catbox.moe rejected the upload (HTTP ${status}${text ? ` — ${text.slice(0, 100)}` : ""}), falling back to litterbox...`)
    } catch (e) {
      const detail = e instanceof DOMException && e.name === "AbortError" ? "timed out" : e instanceof Error ? e.message : "unknown error"
      log("warn", `catbox.moe upload failed (${detail}), falling back to litterbox...`)
    }
  } else {
    log("info", "No catbox userhash provided — using litterbox (anonymous, files kept 72h). Enter your catbox.moe userhash for permanent storage.")
  }

  // Tier 2: anonymous litterbox storage (72h retention)
  if (buffer.length > LITTERBOX_LIMIT_BYTES) {
    const msg = `File is ${sizeMb.toFixed(1)} MB, over litterbox's 1 GB limit — upload skipped`
    log("error", msg)
    return { error: msg }
  }

  log("step", `Uploading ${sizeMb.toFixed(1)} MB to litterbox (expires in ${LITTERBOX_HOURS}h)...`)
  try {
    const form = new FormData()
    form.append("reqtype", "fileupload")
    form.append("time", `${LITTERBOX_HOURS}h`)
    form.append("fileToUpload", file)

    const { status, text } = await postForm(LITTERBOX_API, form, 120000)
    if (status === 200 && isCatboxUrl(text)) {
      const expiresAt = Date.now() + LITTERBOX_HOURS * 60 * 60 * 1000
      log("success", `Uploaded to litterbox: ${text} (expires in ${LITTERBOX_HOURS}h)`)
      return { url: text, expiresAt }
    }
    const msg = `litterbox upload failed (HTTP ${status}${text ? ` — ${text.slice(0, 100)}` : ""})`
    log("error", msg)
    return { error: msg }
  } catch (e) {
    const msg =
      e instanceof DOMException && e.name === "AbortError"
        ? "litterbox upload timed out"
        : `litterbox upload error: ${e instanceof Error ? e.message : "unknown error"}`
    log("error", msg)
    return { error: msg }
  }
}
