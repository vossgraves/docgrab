"use client"

import { useState, useRef, useCallback } from "react"
import { Link2, Loader2, Cloud } from "lucide-react"
import { LogConsole, type LogEntry } from "./log-console"
import { ResultCard, type GrabResult } from "./result-card"
import { addHistoryItem } from "@/lib/history"
import type { StreamEvent, OutputFormat } from "@/lib/types"

type Status = "idle" | "running" | "done" | "error"

function detectPlatformLabel(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return null
  try {
    const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    const host = new URL(normalized).hostname.toLowerCase()
    if (host === "slideshare.net" || host.endsWith(".slideshare.net")) return "slideshare"
    if (host === "scribd.com" || host.endsWith(".scribd.com")) return "scribd"
    return "public"
  } catch {
    return null
  }
}

export function Downloader() {
  const [url, setUrl] = useState("")
  const [format, setFormat] = useState<OutputFormat>("pdf")
  const [saveToCatbox, setSaveToCatbox] = useState(false)
  const [catboxUserhash, setCatboxUserhash] = useState("")
  const [status, setStatus] = useState<Status>("idle")
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [progress, setProgress] = useState<{ current: number; total: number; label: string } | null>(null)
  const [result, setResult] = useState<GrabResult | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const submittedUrlRef = useRef("")

  const platform = detectPlatformLabel(url)
  const isRunning = status === "running"
  const pptxDisabled = platform === "scribd"
  const effectiveFormat: OutputFormat = pptxDisabled ? "pdf" : format

  const addLog = useCallback((entry: LogEntry) => {
    setLogs((prev) => [...prev, entry])
  }, [])

  const handleEvent = useCallback(
    (event: StreamEvent) => {
      switch (event.type) {
        case "log":
          addLog({ level: event.level, message: event.message, timestamp: event.timestamp })
          if (event.level === "step") setProgress(null)
          break
        case "progress":
          setProgress({ current: event.current, total: event.total, label: event.label })
          break
        case "result": {
          // Build a local blob URL from the inline bytes so the download works
          // even on serverless hosting where /tmp is per-instance.
          let blobUrl: string | undefined
          if (event.fileBase64) {
            try {
              const bytes = Uint8Array.from(atob(event.fileBase64), (c) => c.charCodeAt(0))
              const mime =
                event.format === "pptx"
                  ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
                  : "application/pdf"
              blobUrl = URL.createObjectURL(new Blob([bytes], { type: mime }))
            } catch {
              // Fall back to the server file route below.
            }
          }
          setResult((prev) => {
            if (prev?.blobUrl) URL.revokeObjectURL(prev.blobUrl)
            return {
              id: event.id,
              title: event.title,
              pages: event.pages,
              size: event.size,
              platform: event.platform,
              format: event.format,
              textSelectable: event.textSelectable,
              sourceUrl: event.sourceUrl,
              catboxUrl: event.catboxUrl,
              catboxExpiresAt: event.catboxExpiresAt,
              blobUrl,
            }
          })
          if (event.catboxUrl) {
            addHistoryItem({
              title: event.title,
              url: submittedUrlRef.current,
              platform: event.platform,
              format: event.format,
              pages: event.pages,
              size: event.size,
              catboxUrl: event.catboxUrl,
              expiresAt: event.catboxExpiresAt,
            })
          }
          setProgress(null)
          setStatus("done")
          break
        }
        case "error":
          setProgress(null)
          setStatus("error")
          break
      }
    },
    [addLog],
  )

  const grab = useCallback(async () => {
    if (!url.trim() || isRunning) return

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setStatus("running")
    setLogs([])
    setResult(null)
    setProgress(null)
    submittedUrlRef.current = url.trim()

    try {
      const resp = await fetch("/api/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          format: effectiveFormat,
          uploadToCatbox: saveToCatbox,
          catboxUserhash: saveToCatbox ? catboxUserhash.trim() : "",
        }),
        signal: controller.signal,
      })

      if (!resp.ok) {
        const data = await resp.json().catch(() => ({ error: `Request failed (HTTP ${resp.status})` }))
        addLog({ level: "error", message: data.error ?? "Request failed", timestamp: Date.now() })
        setStatus("error")
        return
      }

      if (!resp.body) {
        addLog({ level: "error", message: "No response stream received", timestamp: Date.now() })
        setStatus("error")
        return
      }

      // Parse NDJSON stream line by line
      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            handleEvent(JSON.parse(line) as StreamEvent)
          } catch {
            // skip malformed lines
          }
        }
      }
      if (buffer.trim()) {
        try {
          handleEvent(JSON.parse(buffer) as StreamEvent)
        } catch {
          // skip malformed trailing data
        }
      }

      // If stream ended without a result or error event, mark as error
      setStatus((prev) => (prev === "running" ? "error" : prev))
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return
      addLog({
        level: "error",
        message: e instanceof Error ? e.message : "Connection lost",
        timestamp: Date.now(),
      })
      setStatus("error")
    }
  }, [url, isRunning, addLog, handleEvent, effectiveFormat, saveToCatbox, catboxUserhash])

  return (
    <div className="flex flex-col gap-4">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          grab()
        }}
        className="flex flex-col sm:flex-row gap-2"
      >
        <div className="relative flex-1">
          <Link2
            className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none"
            aria-hidden="true"
          />
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.slideshare.net/... or any public document page"
            aria-label="Document URL"
            disabled={isRunning}
            className="w-full rounded-md border border-input bg-card pl-9 pr-20 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
          />
          {platform && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 rounded bg-muted px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
              {platform}
            </span>
          )}
        </div>
        <button
          type="submit"
          disabled={!url.trim() || isRunning}
          className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isRunning ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Grabbing
            </>
          ) : (
            "Grab"
          )}
        </button>
      </form>

      <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-6">
        <fieldset className="flex items-center gap-1" disabled={isRunning}>
          <legend className="sr-only">Output format</legend>
          <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground/60 mr-2">Format</span>
          {(["pdf", "pptx"] as OutputFormat[]).map((f) => {
            const disabled = f === "pptx" && pptxDisabled
            const active = effectiveFormat === f
            return (
              <label
                key={f}
                className={`cursor-pointer rounded-md border px-3 py-1.5 text-xs font-mono uppercase tracking-wider transition-colors ${
                  active
                    ? "border-primary/50 bg-primary/10 text-primary"
                    : "border-border bg-card text-muted-foreground hover:text-foreground"
                } ${disabled ? "opacity-40 cursor-not-allowed" : ""}`}
                title={disabled ? "The rendered Scribd fallback is PDF-only" : undefined}
              >
                <input
                  type="radio"
                  name="format"
                  value={f}
                  checked={active}
                  disabled={disabled}
                  onChange={() => setFormat(f)}
                  className="sr-only"
                />
                {f}
              </label>
            )
          })}
          {pptxDisabled && (
            <span className="text-[10px] font-mono text-muted-foreground/50 ml-1">scribd fallback: pdf only</span>
          )}
        </fieldset>

        <label
          className={`flex items-center gap-2 cursor-pointer select-none ${isRunning ? "opacity-60 pointer-events-none" : ""}`}
        >
          <input
            type="checkbox"
            checked={saveToCatbox}
            onChange={(e) => setSaveToCatbox(e.target.checked)}
            disabled={isRunning}
            className="size-3.5 rounded border-border bg-card accent-primary"
          />
          <span className="inline-flex items-center gap-1.5 text-xs font-mono text-muted-foreground">
            <Cloud className="size-3.5" aria-hidden="true" />
            Save to catbox.moe (keeps file in History)
          </span>
        </label>
      </div>

      {saveToCatbox && (
        <div className="flex flex-col gap-1.5">
          <div className="relative">
            <input
              type="text"
              value={catboxUserhash}
              onChange={(e) => setCatboxUserhash(e.target.value)}
              placeholder="catbox.moe userhash (optional — leave blank for 72h temporary link)"
              aria-label="catbox.moe userhash"
              disabled={isRunning}
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-md border border-input bg-card px-3 py-2 text-xs font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
            />
          </div>
          <p className="text-[10px] font-mono text-muted-foreground/50 leading-relaxed">
            {catboxUserhash.trim()
              ? "Permanent storage on your catbox.moe account."
              : "No userhash: files upload anonymously to litterbox and expire after 72 hours. Get a userhash from catbox.moe → Account."}
          </p>
        </div>
      )}

      {result && status === "done" && <ResultCard result={result} />}

      <LogConsole logs={logs} isRunning={isRunning} progress={progress} />
    </div>
  )
}
