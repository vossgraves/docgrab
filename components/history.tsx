"use client"

import { useEffect, useState, useCallback } from "react"
import { Cloud, Download, Trash2, History as HistoryIcon } from "lucide-react"
import { getHistory, removeHistoryItem, clearHistory, type HistoryItem } from "@/lib/history"

function formatDate(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " +
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}

function expiryLabel(expiresAt: number): string {
  const hoursLeft = Math.max(0, Math.round((expiresAt - Date.now()) / (60 * 60 * 1000)))
  return hoursLeft >= 1 ? `expires in ${hoursLeft}h` : "expiring soon"
}

export function History() {
  const [items, setItems] = useState<HistoryItem[]>([])
  const [mounted, setMounted] = useState(false)

  const refresh = useCallback(() => setItems(getHistory()), [])

  useEffect(() => {
    setMounted(true)
    refresh()
    const onChange = () => refresh()
    window.addEventListener("docgrab:history-changed", onChange)
    window.addEventListener("storage", onChange)
    return () => {
      window.removeEventListener("docgrab:history-changed", onChange)
      window.removeEventListener("storage", onChange)
    }
  }, [refresh])

  // Avoid hydration mismatch: render nothing until mounted on the client.
  if (!mounted) return null

  return (
    <section aria-label="Saved history" className="flex flex-col gap-3">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <HistoryIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
            History{items.length > 0 ? ` · ${items.length}` : ""}
          </h2>
        </div>
        {items.length > 0 && (
          <button
            type="button"
            onClick={() => setItems(clearHistory())}
            className="inline-flex items-center gap-1.5 text-xs font-mono text-muted-foreground/60 hover:text-destructive transition-colors"
          >
            <Trash2 className="size-3" aria-hidden="true" />
            Clear
          </button>
        )}
      </header>

      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border bg-card/50 px-4 py-6 text-center text-xs text-muted-foreground/50 font-mono">
          {"No saved files yet. Tick \"Save to catbox.moe\" before grabbing to keep files here."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5"
            >
              <Cloud className="size-4 shrink-0 text-primary" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-foreground truncate">{item.title}</p>
                <p className="text-[11px] font-mono text-muted-foreground/70 mt-0.5">
                  {item.platform} · {item.format.toUpperCase()} · {item.pages}p · {item.size} · {formatDate(item.savedAt)}
                  {item.expiresAt ? ` · ${expiryLabel(item.expiresAt)}` : ""}
                </p>
              </div>
              <a
                href={item.catboxUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Download ${item.title} from catbox.moe`}
                className="inline-flex items-center justify-center rounded-md border border-border p-2 text-muted-foreground hover:text-primary hover:border-primary/40 transition-colors shrink-0"
              >
                <Download className="size-4" aria-hidden="true" />
              </a>
              <button
                type="button"
                onClick={() => setItems(removeHistoryItem(item.id))}
                aria-label={`Remove ${item.title} from history`}
                className="inline-flex items-center justify-center rounded-md p-2 text-muted-foreground/50 hover:text-destructive transition-colors shrink-0"
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
