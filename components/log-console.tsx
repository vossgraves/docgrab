"use client"

import { useEffect, useRef } from "react"
import type { LogLevel } from "@/lib/types"

export interface LogEntry {
  level: LogLevel
  message: string
  timestamp: number
}

const LEVEL_STYLES: Record<LogLevel, { prefix: string; className: string }> = {
  info: { prefix: "INFO", className: "text-muted-foreground" },
  step: { prefix: "STEP", className: "text-foreground font-medium" },
  success: { prefix: " OK ", className: "text-primary" },
  warn: { prefix: "WARN", className: "text-warning" },
  error: { prefix: "FAIL", className: "text-destructive" },
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":")
}

interface LogConsoleProps {
  logs: LogEntry[]
  isRunning: boolean
  progress: { current: number; total: number; label: string } | null
}

export function LogConsole({ logs, isRunning, progress }: LogConsoleProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs, progress])

  return (
    <section aria-label="Process logs" className="rounded-lg border border-border bg-card overflow-hidden">
      <header className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={`size-1.5 rounded-full ${isRunning ? "bg-primary animate-pulse" : "bg-muted-foreground/40"}`}
          />
          <h2 className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Process Log</h2>
        </div>
        <span className="text-xs font-mono text-muted-foreground/60">
          {logs.length} {logs.length === 1 ? "entry" : "entries"}
        </span>
      </header>

      <div
        ref={scrollRef}
        className="h-72 overflow-y-auto px-4 py-3 font-mono text-xs leading-relaxed"
        role="log"
        aria-live="polite"
      >
        {logs.length === 0 ? (
          <p className="text-muted-foreground/50">
            {"Awaiting job... paste a SlideShare or Scribd URL above and press Grab."}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {logs.map((entry, i) => {
              const style = LEVEL_STYLES[entry.level]
              return (
                <li key={i} className="flex gap-3">
                  <span className="shrink-0 text-muted-foreground/40 tabular-nums">{formatTime(entry.timestamp)}</span>
                  <span
                    className={`shrink-0 w-10 ${
                      entry.level === "error"
                        ? "text-destructive"
                        : entry.level === "success"
                          ? "text-primary"
                          : entry.level === "warn"
                            ? "text-warning"
                            : "text-muted-foreground/60"
                    }`}
                  >
                    {style.prefix}
                  </span>
                  <span className={`${style.className} break-all`}>{entry.message}</span>
                </li>
              )
            })}
            {progress && progress.total > 0 && (
              <li className="flex gap-3 items-center pt-1">
                <span className="shrink-0 text-muted-foreground/40">{"    "}</span>
                <span className="text-primary shrink-0">
                  {progress.label} {progress.current}/{progress.total}
                </span>
                <span
                  className="flex-1 h-1 rounded-full bg-muted overflow-hidden max-w-48"
                  role="progressbar"
                  aria-valuenow={progress.current}
                  aria-valuemax={progress.total}
                  aria-label={progress.label}
                >
                  <span
                    className="block h-full bg-primary transition-all duration-200"
                    style={{ width: `${Math.round((progress.current / progress.total) * 100)}%` }}
                  />
                </span>
              </li>
            )}
            {isRunning && (
              <li aria-hidden="true" className="text-primary animate-pulse">
                {"▋"}
              </li>
            )}
          </ul>
        )}
      </div>
    </section>
  )
}
