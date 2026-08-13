"use client"

import { useEffect } from "react"

/**
 * Spawns a short-lived expanding ring at primary pointer positions without React
 * state. The effect is disabled for reduced motion and bounded during rapid taps.
 */
export function ClickRipple() {
  useEffect(() => {
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)")
    let activeRings = 0

    const onPointerDown = (event: PointerEvent) => {
      if (
        motionQuery.matches ||
        document.hidden ||
        !event.isPrimary ||
        event.button !== 0 ||
        activeRings >= 3 ||
        (event.clientX === 0 && event.clientY === 0)
      ) {
        return
      }

      activeRings += 1
      const ring = document.createElement("span")
      ring.className = "click-ping"
      ring.style.left = `${event.clientX}px`
      ring.style.top = `${event.clientY}px`
      ring.setAttribute("aria-hidden", "true")
      document.body.appendChild(ring)

      const remove = () => {
        if (!ring.isConnected) return
        ring.remove()
        activeRings = Math.max(0, activeRings - 1)
      }

      ring.addEventListener("animationend", remove, { once: true })
      window.setTimeout(remove, 650)
    }

    window.addEventListener("pointerdown", onPointerDown, { passive: true })
    return () => window.removeEventListener("pointerdown", onPointerDown)
  }, [])

  return null
}
