"use client"

import type { OutputFormat, Platform } from "./types"

// History lives entirely in the browser (localStorage) so no host storage is used.
// The actual files live on catbox.moe; we only keep their links + metadata here.
const STORAGE_KEY = "docgrab:history"
const MAX_ENTRIES = 50

export interface HistoryItem {
  id: string
  title: string
  url: string
  platform: Platform
  format: OutputFormat
  pages: number
  size: string
  catboxUrl: string
  savedAt: number
  /** Present when stored on litterbox — the link dies after this time. */
  expiresAt?: number
}

export function getHistory(): HistoryItem[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Drop entries whose litterbox links have already expired.
    const now = Date.now()
    const items = (parsed as HistoryItem[]).filter((h) => !h.expiresAt || h.expiresAt > now)
    if (items.length !== parsed.length) persist(items)
    return items
  } catch {
    return []
  }
}

export function addHistoryItem(item: Omit<HistoryItem, "id" | "savedAt">): HistoryItem[] {
  const entry: HistoryItem = {
    ...item,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    savedAt: Date.now(),
  }
  const next = [entry, ...getHistory()].slice(0, MAX_ENTRIES)
  persist(next)
  return next
}

export function removeHistoryItem(id: string): HistoryItem[] {
  const next = getHistory().filter((h) => h.id !== id)
  persist(next)
  return next
}

export function clearHistory(): HistoryItem[] {
  persist([])
  return []
}

function persist(items: HistoryItem[]) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
    // Notify listeners in the same tab (storage event only fires cross-tab).
    window.dispatchEvent(new CustomEvent("docgrab:history-changed"))
  } catch {
    // storage full or unavailable — ignore
  }
}
