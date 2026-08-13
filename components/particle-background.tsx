"use client"

import { useEffect, useRef } from "react"

interface Dot {
  x: number
  y: number
  vx: number
  vy: number
  r: number
}

const POINTER_LINK_DIST = 170
const DOT_LINK_DIST = 84
const MAX_SPEED = 0.3
const FRAME_INTERVAL = 1000 / 30

export function ParticleBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)")
    if (motionQuery.matches) return

    const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true })
    if (!ctx) return

    let width = 0
    let height = 0
    let dots: Dot[] = []
    let raf = 0
    let resizeRaf = 0
    let lastFrame = 0
    let visible = !document.hidden
    const pointer = { x: -9999, y: -9999, active: false }
    // A lower internal resolution keeps the same subtle background aesthetic while
    // avoiding high-DPR canvas work on phones and inexpensive laptops.
    const dpr = Math.min(window.devicePixelRatio || 1, window.innerWidth < 768 ? 1 : 1.25)

    const seed = () => {
      const density = width < 768 ? 30000 : 21000
      const maxDots = width < 768 ? 32 : 52
      const count = Math.min(maxDots, Math.max(16, Math.floor((width * height) / density)))
      dots = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * MAX_SPEED * 2,
        vy: (Math.random() - 0.5) * MAX_SPEED * 2,
        r: 1 + Math.random(),
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

    const scheduleResize = () => {
      cancelAnimationFrame(resizeRaf)
      resizeRaf = requestAnimationFrame(resize)
    }

    const onPointerMove = (event: PointerEvent) => {
      if (!event.isPrimary) return
      pointer.x = event.clientX
      pointer.y = event.clientY
      pointer.active = true
    }

    const onPointerLeave = () => {
      pointer.active = false
      pointer.x = -9999
      pointer.y = -9999
    }

    const draw = (delta: number) => {
      const step = Math.min(2, delta / FRAME_INTERVAL)
      ctx.clearRect(0, 0, width, height)

      for (const dot of dots) {
        dot.x += dot.vx * step
        dot.y += dot.vy * step
        if (dot.x < -10) dot.x = width + 10
        else if (dot.x > width + 10) dot.x = -10
        if (dot.y < -10) dot.y = height + 10
        else if (dot.y > height + 10) dot.y = -10
      }

      ctx.lineWidth = 1
      for (let i = 0; i < dots.length; i++) {
        const a = dots[i]
        for (let j = i + 1; j < dots.length; j++) {
          const b = dots[j]
          const dx = a.x - b.x
          const dy = a.y - b.y
          const distSq = dx * dx + dy * dy
          if (distSq < DOT_LINK_DIST * DOT_LINK_DIST) {
            const alpha = 0.055 * (1 - Math.sqrt(distSq) / DOT_LINK_DIST)
            ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`
            ctx.beginPath()
            ctx.moveTo(a.x, a.y)
            ctx.lineTo(b.x, b.y)
            ctx.stroke()
          }
        }
      }

      if (pointer.active) {
        for (const dot of dots) {
          const dx = pointer.x - dot.x
          const dy = pointer.y - dot.y
          const distSq = dx * dx + dy * dy
          if (distSq < POINTER_LINK_DIST * POINTER_LINK_DIST) {
            const distance = Math.sqrt(distSq)
            const alpha = 0.24 * (1 - distance / POINTER_LINK_DIST)
            ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`
            ctx.beginPath()
            ctx.moveTo(dot.x, dot.y)
            ctx.lineTo(pointer.x, pointer.y)
            ctx.stroke()
            if (distance > 24) {
              dot.vx += (dx / distance) * 0.003
              dot.vy += (dy / distance) * 0.003
            }
          }
          const speed = Math.hypot(dot.vx, dot.vy)
          if (speed > MAX_SPEED) {
            dot.vx = (dot.vx / speed) * MAX_SPEED
            dot.vy = (dot.vy / speed) * MAX_SPEED
          }
        }
      }

      ctx.fillStyle = "rgba(255, 255, 255, 0.34)"
      ctx.beginPath()
      for (const dot of dots) {
        ctx.moveTo(dot.x + dot.r, dot.y)
        ctx.arc(dot.x, dot.y, dot.r, 0, Math.PI * 2)
      }
      ctx.fill()
    }

    const tick = (now: number) => {
      if (!visible) return
      if (now - lastFrame >= FRAME_INTERVAL) {
        draw(lastFrame ? now - lastFrame : FRAME_INTERVAL)
        lastFrame = now
      }
      raf = requestAnimationFrame(tick)
    }

    const onVisibilityChange = () => {
      visible = !document.hidden
      if (!visible) {
        cancelAnimationFrame(raf)
        raf = 0
        return
      }
      lastFrame = performance.now()
      if (!raf) raf = requestAnimationFrame(tick)
    }

    resize()
    raf = requestAnimationFrame(tick)

    window.addEventListener("resize", scheduleResize, { passive: true })
    window.addEventListener("pointermove", onPointerMove, { passive: true })
    window.addEventListener("pointerdown", onPointerMove, { passive: true })
    window.addEventListener("pointerleave", onPointerLeave, { passive: true })
    document.addEventListener("visibilitychange", onVisibilityChange)

    return () => {
      cancelAnimationFrame(raf)
      cancelAnimationFrame(resizeRaf)
      window.removeEventListener("resize", scheduleResize)
      window.removeEventListener("pointermove", onPointerMove)
      window.removeEventListener("pointerdown", onPointerMove)
      window.removeEventListener("pointerleave", onPointerLeave)
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [])

  return <canvas ref={canvasRef} aria-hidden="true" className="fixed inset-0 z-0 pointer-events-none" />
}
