"use client"

import { useEffect, useRef } from "react"

interface Dot {
  x: number
  y: number
  vx: number
  vy: number
  r: number
}

const POINTER_LINK_DIST = 180
const DOT_LINK_DIST = 90
const MAX_SPEED = 0.35

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

    const seed = () => {
      // Density scales with area, capped to stay cheap on large screens.
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

      // Dot-to-dot links (subtle).
      ctx.lineWidth = 1
      for (let i = 0; i < dots.length; i++) {
        const a = dots[i]
        for (let j = i + 1; j < dots.length; j++) {
          const b = dots[j]
          const dx = a.x - b.x
          const dy = a.y - b.y
          const distSq = dx * dx + dy * dy
          if (distSq < DOT_LINK_DIST * DOT_LINK_DIST) {
            const alpha = 0.06 * (1 - Math.sqrt(distSq) / DOT_LINK_DIST)
            ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`
            ctx.beginPath()
            ctx.moveTo(a.x, a.y)
            ctx.lineTo(b.x, b.y)
            ctx.stroke()
          }
        }
      }

      // Pointer links (stronger) + gentle attraction.
      if (pointer.active) {
        for (const d of dots) {
          const dx = pointer.x - d.x
          const dy = pointer.y - d.y
          const distSq = dx * dx + dy * dy
          if (distSq < POINTER_LINK_DIST * POINTER_LINK_DIST) {
            const dist = Math.sqrt(distSq)
            const alpha = 0.28 * (1 - dist / POINTER_LINK_DIST)
            ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`
            ctx.beginPath()
            ctx.moveTo(d.x, d.y)
            ctx.lineTo(pointer.x, pointer.y)
            ctx.stroke()
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
