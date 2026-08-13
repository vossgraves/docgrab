
import { FileText, Download, Cloud, ExternalLink } from "lucide-react"
import type { OutputFormat, Platform } from "@/lib/types"

export interface GrabResult {
  id: string
  title: string
  pages: number
  size: string
  platform: Platform
  format: OutputFormat
  textSelectable?: boolean
  sourceUrl?: string
  catboxUrl?: string
  catboxExpiresAt?: number
  /** Local blob URL built from inline file bytes — works regardless of server instance. */
  blobUrl?: string
}

function safeFileName(title: string, format: OutputFormat): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
  return `${slug || "document"}.${format}`
}

export function ResultCard({ result }: { result: GrabResult }) {
  const formatLabel = result.format.toUpperCase()
  const downloadHref = result.blobUrl ?? `/api/file/${result.id}`

  return (
    <section
      aria-label="Download result"
      className="rounded-lg border border-primary/30 bg-primary/5 p-4 flex flex-col gap-4"
    >
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          <div className="rounded-md bg-primary/10 p-2 shrink-0">
            <FileText className="size-5 text-primary" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-foreground truncate text-balance">{result.title}</h3>
            <p className="text-xs font-mono text-muted-foreground mt-1">
              {result.platform} · {formatLabel} · {result.pages} pages · {result.size}
            </p>
            <p className="text-xs text-muted-foreground/80 mt-2">
              {result.textSelectable
                ? "Original text/editable objects preserved"
                : "Rendered image export; source did not expose selectable text"}
            </p>
          </div>
        </div>
        <a
          href={downloadHref}
          download={safeFileName(result.title, result.format)}
          className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 transition-opacity shrink-0"
        >
          <Download className="size-4" aria-hidden="true" />
          Download {formatLabel}
        </a>
      </div>

      {result.sourceUrl && (
        <a
          href={result.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs font-mono text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors break-all"
        >
          <ExternalLink className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
          <span className="truncate">Source asset</span>
        </a>
      )}

      {result.catboxUrl && (
        <a
          href={result.catboxUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs font-mono text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors break-all"
        >
          <Cloud className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
          <span className="truncate">{result.catboxUrl}</span>
          {result.catboxExpiresAt && (
            <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground/70">
              expires 72h
            </span>
          )}
        </a>
      )}
    </section>
  )
}
