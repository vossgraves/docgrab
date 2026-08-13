"use client"

import { useEffect, useRef } from "react"

interface Dot {
  x: number
  y: number
  vx: number
  vy: number
  r: number
}

type Segment = [number, number, number, number]

const POINTER_LINK_DIST = 180
const DOT_LINK_DIST = 90
const MAX_SPEED = 0.35
const LINK_ALPHA_BUCKETS = 8

function cellKey(x: number, y: number): string {
  return `${x}:${y}`
}

export function ParticleBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    // Respect reduced-motion preferences.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return

    const ctx = canvas.getContext("2d")
    if (!ctx) return

    let width = 0
    let height = 0
    let dots: Dot[] = []
    let raf = 0
    const pointer = { x: -9999, y: -9999, active: false }
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const grid = new Map<string, number[]>()
    const dotSegments: Segment[][] = Array.from({ length: LINK_ALPHA_BUCKETS }, () => [])
    const pointerSegments: Segment[][] = Array.from({ length: LINK_ALPHA_BUCKETS }, () => [])

    const seed = () => {
      // Keep the original visual density while preventing large canvases from
      // creating an unbounded connection workload.
      const count = Math.min(110, Math.floor((width * height) / 16000))
      dots = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * MAX_SPEED * 2,
        vy: (Math.random() - 0.5) * MAX_SPEED * 2,
        r: 1 + Math.random() * 1.2,
      }))
    }

    const resize = () => {
      width = window.innerWidth
      height = window.innerHeight
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      seed()
    }

    const onPointerMove = (e: PointerEvent) => {
      pointer.x = e.clientX
      pointer.y = e.clientY
      pointer.active = true
    }
    const onPointerLeave = () => {
      pointer.active = false
      pointer.x = -9999
      pointer.y = -9999
    }
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0]
      if (!t) return
      pointer.x = t.clientX
      pointer.y = t.clientY
      pointer.active = true
    }

    const queueSegment = (segments: Segment[][], alpha: number, segment: Segment, maxAlpha: number) => {
      const bucket = Math.min(
        LINK_ALPHA_BUCKETS - 1,
        Math.max(0, Math.floor((alpha / maxAlpha) * LINK_ALPHA_BUCKETS)),
      )
      segments[bucket].push(segment)
    }

    const strokeSegments = (segments: Segment[][], maxAlpha: number) => {
      ctx.strokeStyle = "rgba(255, 255, 255, 1)"
      for (let bucket = 0; bucket < segments.length; bucket++) {
        const lines = segments[bucket]
        if (lines.length === 0) continue
        ctx.beginPath()
        for (const [x1, y1, x2, y2] of lines) {
          ctx.moveTo(x1, y1)
          ctx.lineTo(x2, y2)
        }
        ctx.globalAlpha = ((bucket + 0.5) / LINK_ALPHA_BUCKETS) * maxAlpha
        ctx.stroke()
      }
      ctx.globalAlpha = 1
    }

    const tick = () => {
      ctx.clearRect(0, 0, width, height)

      for (const d of dots) {
        d.x += d.vx
        d.y += d.vy
        // Wrap around edges for continuous drift.
        if (d.x < -10) d.x = width + 10
        else if (d.x > width + 10) d.x = -10
        if (d.y < -10) d.y = height + 10
        else if (d.y > height + 10) d.y = -10
      }

      // Build a small spatial index. It checks the same 90px neighborhood as
      // the original O(n²) loop, but avoids comparing distant dots at all.
      grid.clear()
      for (let i = 0; i < dots.length; i++) {
        const d = dots[i]
        const key = cellKey(Math.floor(d.x / DOT_LINK_DIST), Math.floor(d.y / DOT_LINK_DIST))
        const bucket = grid.get(key)
        if (bucket) bucket.push(i)
        else grid.set(key, [i])
      }

      for (const segments of dotSegments) segments.length = 0
      for (let i = 0; i < dots.length; i++) {
        const a = dots[i]
        const cellX = Math.floor(a.x / DOT_LINK_DIST)
        const cellY = Math.floor(a.y / DOT_LINK_DIST)
        for (let offsetX = -1; offsetX <= 1; offsetX++) {
          for (let offsetY = -1; offsetY <= 1; offsetY++) {
            const candidates = grid.get(cellKey(cellX + offsetX, cellY + offsetY))
            if (!candidates) continue
            for (const j of candidates) {
              if (j <= i) continue
              const b = dots[j]
              const dx = a.x - b.x
              const dy = a.y - b.y
              const distSq = dx * dx + dy * dy
              if (distSq < DOT_LINK_DIST * DOT_LINK_DIST) {
                const alpha = 0.06 * (1 - Math.sqrt(distSq) / DOT_LINK_DIST)
                queueSegment(dotSegments, alpha, [a.x, a.y, b.x, b.y], 0.06)
              }
            }
          }
        }
      }
      strokeSegments(dotSegments, 0.06)

      // Pointer links (stronger) + gentle attraction.
      for (const segments of pointerSegments) segments.length = 0
      if (pointer.active) {
        for (const d of dots) {
          const dx = pointer.x - d.x
          const dy = pointer.y - d.y
          const distSq = dx * dx + dy * dy
          if (distSq < POINTER_LINK_DIST * POINTER_LINK_DIST) {
            const dist = Math.sqrt(distSq)
            const alpha = 0.28 * (1 - dist / POINTER_LINK_DIST)
            queueSegment(pointerSegments, alpha, [d.x, d.y, pointer.x, pointer.y], 0.28)
            // Slight pull toward the pointer.
            if (dist > 24) {
              d.vx += (dx / dist) * 0.004
              d.vy += (dy / dist) * 0.004
            }
          }
          // Clamp speed so attraction never snowballs.
          const speed = Math.hypot(d.vx, d.vy)
          if (speed > MAX_SPEED) {
            d.vx = (d.vx / speed) * MAX_SPEED
            d.vy = (d.vy / speed) * MAX_SPEED
          }
        }
        strokeSegments(pointerSegments, 0.28)
      }

      // Draw dots last so they sit on top of lines.
      ctx.fillStyle = "rgba(255, 255, 255, 0.35)"
      for (const d of dots) {
        ctx.beginPath()
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2)
        ctx.fill()
      }

      raf = requestAnimationFrame(tick)
    }

    resize()
    raf = requestAnimationFrame(tick)

    window.addEventListener("resize", resize)
    window.addEventListener("pointermove", onPointerMove, { passive: true })
    window.addEventListener("pointerdown", onPointerMove, { passive: true })
    window.addEventListener("touchmove", onTouchMove, { passive: true })
    document.addEventListener("mouseleave", onPointerLeave)
    window.addEventListener("touchend", onPointerLeave)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener("resize", resize)
      window.removeEventListener("pointermove", onPointerMove)
      window.removeEventListener("pointerdown", onPointerMove)
      window.removeEventListener("touchmove", onTouchMove)
      document.removeEventListener("mouseleave", onPointerLeave)
      window.removeEventListener("touchend", onPointerLeave)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="fixed inset-0 z-0 pointer-events-none"
    />
  )
}
