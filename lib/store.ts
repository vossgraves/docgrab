import { mkdir, writeFile, readFile, readdir, stat, unlink } from "fs/promises"
import { existsSync } from "fs"
import path from "path"
import os from "os"
import crypto from "crypto"

const STORE_DIR = path.join(os.tmpdir(), "docgrab-store")
const MAX_AGE_MS = 60 * 60 * 1000 // 1 hour

export type FileExt = "pdf" | "pptx"

async function ensureDir() {
  if (!existsSync(STORE_DIR)) {
    await mkdir(STORE_DIR, { recursive: true })
  }
}

export function slugify(text: string): string {
  const cleaned = text
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .slice(0, 80)
  return cleaned || "document"
}

/** Persist a generated file to the temp store and return its opaque id. */
export async function saveFile(buffer: Buffer, title: string, ext: FileExt): Promise<string> {
  await ensureDir()
  const id = `${slugify(title)}_${crypto.randomBytes(4).toString("hex")}`
  await writeFile(path.join(STORE_DIR, `${id}.${ext}`), buffer)
  // Fire-and-forget cleanup of stale files
  cleanupOldFiles().catch(() => {})
  return id
}

/** Load a stored file by id, resolving its extension automatically. */
export async function getFile(id: string): Promise<{ buffer: Buffer; ext: FileExt } | null> {
  // Sanitize: only allow safe id characters, prevent path traversal
  if (!/^[\w-]+$/.test(id)) return null
  for (const ext of ["pdf", "pptx"] as FileExt[]) {
    const filepath = path.join(STORE_DIR, `${id}.${ext}`)
    try {
      const buffer = await readFile(filepath)
      return { buffer, ext }
    } catch {
      // try next extension
    }
  }
  return null
}

export async function cleanupOldFiles(): Promise<void> {
  try {
    await ensureDir()
    const now = Date.now()
    const files = await readdir(STORE_DIR)
    await Promise.allSettled(
      files.map(async (f) => {
        const fp = path.join(STORE_DIR, f)
        const s = await stat(fp)
        if (now - s.mtimeMs > MAX_AGE_MS) {
          await unlink(fp)
        }
      }),
    )
  } catch {
    // best-effort cleanup
  }
}
