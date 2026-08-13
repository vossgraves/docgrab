export type LogLevel = "info" | "success" | "warn" | "error" | "step"

export interface LogEvent {
  type: "log"
  level: LogLevel
  message: string
  timestamp: number
}

export interface ProgressEvent {
  type: "progress"
  current: number
  total: number
  label: string
}

export type OutputFormat = "pdf" | "pptx"
export type Platform = "slideshare" | "scribd" | "public"

export interface DownloadOptions {
  format: OutputFormat
  uploadToCatbox: boolean
  /** Optional catbox.moe account userhash for permanent storage. */
  catboxUserhash?: string
}

export interface ResultEvent {
  type: "result"
  id: string
  title: string
  pages: number
  size: string
  platform: Platform
  format: OutputFormat
  /** True when the returned file retains the source text/editable objects. */
  textSelectable?: boolean
  /** Present for public sources so the user can audit the selected asset. */
  sourceUrl?: string
  /** Public Vercel Blob URL for the 12-hour generated-file cache. */
  cachedUrl?: string
  /** Expiry timestamp for the generated-file cache entry. */
  cachedExpiresAt?: number
  /** True when this result was returned without rebuilding the source document. */
  cacheHit?: boolean
  catboxUrl?: string
  /** Set when the file was stored on litterbox (anonymous tier) and will expire. */
  catboxExpiresAt?: number
  /**
   * Optional inline bytes. Small files use this for instant client-side download;
   * larger files include cachedUrl or catboxUrl so the browser does not depend on instance-local /tmp.
   */
  fileBase64?: string
}

export interface ErrorEvent {
  type: "error"
  message: string
}

export type StreamEvent = LogEvent | ProgressEvent | ResultEvent | ErrorEvent

export type Logger = (level: LogLevel, message: string) => void
export type ProgressReporter = (current: number, total: number, label: string) => void
