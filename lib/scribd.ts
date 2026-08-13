import { launchBrowser } from "./browser"
import { storeForDownload } from "./delivery"
import { getUserAgent } from "./user-agent"
import { downloadPublicDocument } from "./public-document"
import { fetchImpersonated, isChallengePage } from "./impersonate"
import type { Page } from "puppeteer-core"
import type { Logger, ProgressReporter, DownloadOptions, OutputFormat } from "./types"

interface ScribdResult {
  id: string
  title: string
  pages: number
  size: string
  format: OutputFormat
  cachedUrl?: string
  cachedExpiresAt?: number
  catboxUrl?: string
  catboxExpiresAt?: number
  fileBase64?: string
  textSelectable?: boolean
  sourceUrl?: string
}

export async function downloadScribd(
  url: string,
  log: Logger,
  progress: ProgressReporter,
  options: DownloadOptions = { format: "pdf", uploadToCatbox: false },
): Promise<{ result?: ScribdResult; error?: string }> {
  log("step", "Starting Scribd pipeline")
  if (options.format === "pptx") {
    log("warn", "PPTX is not supported for Scribd documents — exporting as PDF instead")
  }

  const match = url.match(/scribd\.com\/(?:document|doc|presentation)\/(\d+)/)
  if (!match) {
    return { error: "Invalid Scribd URL. Expected format: scribd.com/document/<id>/..." }
  }
  const docId = match[1]
  const embedUrl = `https://www.scribd.com/embeds/${docId}/content`
  log("info", `Document ID: ${docId}`)

  // If Scribd exposes an ordinary public original file, preserve it instead of
  // re-printing a rendered page. No login, paywall, DRM, or protected export is
  // attempted here; the helper only follows public document assets in markup.
  const original = await downloadPublicDocument(url, log, progress, options)
  if (original.result) {
    log("success", "Using the public original Scribd file")
    return {
      result: {
        id: original.result.id,
        title: original.result.title,
        pages: original.result.pages,
        size: original.result.size,
        format: original.result.format,
        cachedUrl: original.result.cachedUrl,
        cachedExpiresAt: original.result.cachedExpiresAt,
        catboxUrl: original.result.catboxUrl,
        catboxExpiresAt: original.result.catboxExpiresAt,
        fileBase64: original.result.fileBase64,
        textSelectable: original.result.textSelectable,
        sourceUrl: original.result.sourceUrl,
      },
    }
  }
  if (original.error) log("info", `No public original Scribd file found: ${original.error}`)

  let title = `Scribd ${docId}`
  try {
    const pathname = new URL(url).pathname.replace(/\/$/, "")
    const lastSegment = decodeURIComponent(pathname.split("/").pop() ?? "")
    if (lastSegment && !/^\d+$/.test(lastSegment)) {
      title = lastSegment.replace(/-/g, " ")
    }
  } catch {
    // keep fallback title
  }
  log("info", `Resolved title: ${title}`)

  const waitMillis = (ms: number) => new Promise((r) => setTimeout(r, ms))

  // Fastly serves a JS client challenge shell (/_fs-ch-*) to datacenter
  // traffic. In a real browser the challenge solves itself and drops a cookie
  // into the session. Detect that shell so we can wait for it instead of
  // mistaking it for a document with no pages.
  const isChallengeShell = async (page: Page) =>
    page.evaluate(() => {
      const haystack = `${document.title}\n${document.documentElement?.outerHTML?.slice(0, 20000) ?? ""}\n${document.body?.innerText?.slice(0, 2000) ?? ""}`
      return /client challenge|_fs-ch-|please enable javascript to proceed/i.test(haystack)
    })

  // Visit a page and wait for the Fastly client challenge to auto-resolve in
  // this browser (a normal visitor never sees it). Returns true when the real
  // page content replaced the challenge shell.
  const passClientChallenge = async (
    page: Page,
    visitUrl: string,
    timeoutMs: number,
  ) => {
    await page.goto(visitUrl, { waitUntil: "domcontentloaded", timeout: 60000 })
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!(await isChallengeShell(page))) return true
      await waitMillis(1000)
    }
    return false
  }

  // The embed page HTML already contains every page definition
  // (docManager.addPage blocks whose contentUrl points at a JSONP file on
  // html.scribdassets.com, a public CDN). The in-page reader fetches those
  // JSONPs with a page token that occasionally fails to refresh in a
  // headless browser — every page load then errors and the embed renders
  // zero pages, which surfaces as the misleading "No pages found" error.
  // Fetch the JSONPs from Node instead and hand the bodies to the browser.
  const fetchPageJsonp = async (rawUrl: string): Promise<string | null> => {
    const fetchOne = async (url: string) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30000)
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": getUserAgent(), Accept: "*/*" },
          signal: controller.signal,
        })
        if (!res.ok) return null
        const text = await res.text()
        return text.trim().length > 0 ? text : null
      } catch {
        return null
      } finally {
        clearTimeout(timer)
      }
    }
    // Most docs serve bare public JSONPs; a few require the reader's page
    // token. Try without the token first, then with the one the browser got.
    const withoutToken = rawUrl.replace(/([?&])token=[^&#]+/, "$1")
    return (await fetchOne(withoutToken)) ?? (await fetchOne(rawUrl))
  }

  // The embed HTML is the only part of the flow that Fastly gates. Try to
  // fetch it from Node before spinning up the browser dance: plain fetch
  // first (works when the CDN serves the embed directly), then a Chrome-TLS
  // impersonated request (defeats the _fs-ch client-challenge shell without
  // waiting for a browser challenge to auto-resolve). Returns real HTML or
  // null when the embed is unreachable/challenged from this network.
  const fetchEmbedHtml = async (): Promise<string | null> => {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30000)
      try {
        const res = await fetch(embedUrl, {
          headers: { "User-Agent": getUserAgent(), Accept: "*/*" },
          signal: controller.signal,
        })
        const text = res.ok ? await res.text() : ""
        if (text.trim().length > 0 && !isChallengePage(text)) {
          log("info", "Embed HTML fetched directly, no challenge")
          return text
        }
      } catch {
        // fall through to impersonated fetch
      } finally {
        clearTimeout(timer)
      }
    } catch {
      // fall through to impersonated fetch
    }
    const impersonated = await fetchImpersonated(embedUrl, log, 30000)
    if (impersonated && !isChallengePage(impersonated.buffer.toString("utf8"))) {
      log("success", "Embed HTML retrieved via Chrome TLS fingerprint (no browser challenge)")
      return impersonated.buffer.toString("utf8")
    }
    return null
  }

  let browser: Awaited<ReturnType<typeof launchBrowser>> | null = null
  try {
    log("step", "Launching headless browser...")
    browser = await launchBrowser(log)
    const page = await browser.newPage()
    await page.setUserAgent(getUserAgent())
    page.setDefaultTimeout(60000)

    // Serve every JSONP page payload from Node so rendering no longer depends
    // on the in-page token machinery (see fetchPageJsonp above).
    await page.setRequestInterception(true)
    page.on("request", (request) => {
      if (/\.jsonp(?:$|[?#])/i.test(request.url())) {
        fetchPageJsonp(request.url())
          .then((body) => (body ? request.respond({ status: 200, contentType: "application/x-javascript", body }) : request.continue()))
          .catch(() => request.continue().catch(() => {}))
        return
      }
      request.continue().catch(() => {})
    })

    // Load the embed: the page definitions and their JSONP payloads live on
    // Scribd's public CDN and need no session cookie. When the pre-fetched
    // HTML made it past Fastly, hand it straight to the browser — no
    // challenge wait. Otherwise fall back to a real navigation, priming the
    // session via the document page only if Fastly answers with a
    // client-challenge shell, then reload.
    log("info", `Loading embed page: ${embedUrl}`)
    const embedHtml = await fetchEmbedHtml()
    if (embedHtml) {
      await page.setContent(embedHtml, { waitUntil: "domcontentloaded", timeout: 60000 })
      await waitMillis(1200)
    } else {
      await page.goto(embedUrl, { waitUntil: "domcontentloaded", timeout: 60000 })
      await waitMillis(1200)
      if (await isChallengeShell(page)) {
        log("info", "Embed is behind a client challenge; priming session via the document page...")
        const primed = await passClientChallenge(page, `https://www.scribd.com/document/${docId}`, 12000)
        if (!primed) {
          return {
            error:
              "Scribd's anti-bot challenge did not auto-resolve from this server's network. DocGrab does not attempt to solve CAPTCHAs or bypass login or paywalls, so this document cannot be downloaded right now. Try again later.",
          }
        }
        log("success", "Client challenge passed, session primed")
        await page.goto(embedUrl, { waitUntil: "domcontentloaded", timeout: 60000 })
        await waitMillis(1200)
      }
    }

    // Scribd's embed shows an explicit "unavailable" panel for documents the
    // owner deleted or restricted. Report that accurately instead of the
    // generic "no pages" message, and remember how many page definitions the
    // HTML actually shipped so later failures can be diagnosed precisely.
    const embedState = await page.evaluate(() => {
      const haystack = `${document.body?.innerText?.slice(0, 4000) ?? ""}\n${document.documentElement?.outerHTML?.slice(0, 40000) ?? ""}`
      return {
        unavailable: /embeds_unavailable|document deleted by owner|can.t display this document/i.test(haystack),
        pageDefs: (document.documentElement?.outerHTML?.match(/docManager\.addPage/g) ?? []).length,
      }
    })
    log("info", `Embed page definitions: ${embedState.pageDefs} page${embedState.pageDefs === 1 ? "" : "s"}`)
    if (embedState.unavailable) {
      return {
        error:
          "This Scribd document is unavailable: it has been removed, deleted, or restricted by its owner.",
      }
    }

    // Remove cookie/consent banners
    log("info", "Removing consent banners and overlays...")
    await page.evaluate(() => {
      const selectors = [
        '[class*="cookie"]',
        '[class*="consent"]',
        '[id*="cookie"]',
        "#onetrust-consent-sdk",
        ".cc-window",
      ]
      for (const s of selectors) {
        try {
          document.querySelectorAll(s).forEach((e) => e.remove())
        } catch {
          // ignore selector errors
        }
      }
    })

    // Scroll through pages to trigger lazy loading, until page count stabilizes
    log("step", "Scrolling document to trigger lazy loading...")
    let scrolled = 0
    let stable = 0
    let lastTotal = -1
    let pageCount = 0
    let emptyChecks = 0
    let embedReloads = 0
    const maxIterations = 240

    const pageCountInDom = async () =>
      page.evaluate(() => {
        const selectors = [
          ".outer_page",
          ".newpage",
          "[data-page-number]",
          "[data-page-index]",
          "[class~='page']",
          "[class*='page_container']",
          "[class*='page-wrapper']",
        ]
        const nodes = new Set<Element>()
        for (const selector of selectors) {
          document.querySelectorAll(selector).forEach((node) => nodes.add(node))
        }
        return nodes.size
      })

    for (let iter = 0; iter < maxIterations && stable < 3; iter++) {
      const total = await pageCountInDom()
      if (total === 0) {
        emptyChecks++
        if (emptyChecks >= 12) {
          // The embed occasionally still lands on the challenge shell even
          // after priming. A reload then serves it with the session cookie.
          if (embedReloads < 2 && (await isChallengeShell(page))) {
            embedReloads++
            emptyChecks = 0
            log("warn", `Embed still behind the client challenge, reloading (attempt ${embedReloads})...`)
            await page.goto(embedUrl, { waitUntil: "domcontentloaded", timeout: 60000 })
            await waitMillis(2000)
            continue
          }
          if (embedState.pageDefs === 0) {
            return {
              error: (await isChallengeShell(page))
                ? "Scribd's anti-bot challenge blocked the embed from this server's network. Try again later."
                : "This Scribd document is unavailable: it has been removed, deleted, or restricted by its owner.",
            }
          }
          return {
            error: (await isChallengeShell(page))
              ? "Scribd's anti-bot challenge blocked the embed from this server's network. Try again later."
              : "No pages found. The document may be restricted, removed, or unavailable to this visitor.",
          }
        }
        await new Promise((r) => setTimeout(r, 500))
        continue
      }
      emptyChecks = 0
      if (total === lastTotal) {
        stable++
      } else {
        stable = 0
        progress(total, total, "Loading pages")
        log("info", `Discovered ${total} page elements so far...`)
      }
      lastTotal = total

      for (let i = scrolled; i < total; i++) {
        await page.evaluate((idx) => {
          const selectors = [
            ".outer_page",
            ".newpage",
            "[data-page-number]",
            "[data-page-index]",
            "[class~='page']",
            "[class*='page_container']",
            "[class*='page-wrapper']",
          ]
          const nodes = new Set<Element>()
          for (const selector of selectors) document.querySelectorAll(selector).forEach((node) => nodes.add(node))
          Array.from(nodes)[idx]?.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "center" })
        }, i)
        await new Promise((r) => setTimeout(r, 70))
      }
      scrolled = total
      pageCount = total
      await new Promise((r) => setTimeout(r, 350))
    }
    if (pageCount === 0) {
      if (embedState.pageDefs === 0) {
        return {
          error: (await isChallengeShell(page))
            ? "Scribd's anti-bot challenge blocked the embed from this server's network. Try again later."
            : "This Scribd document is unavailable: it has been removed, deleted, or restricted by its owner.",
        }
      }
      return {
        error: (await isChallengeShell(page))
          ? "Scribd's anti-bot challenge blocked the embed from this server's network. Try again later."
          : "No pages found. The document may be restricted, removed, or unavailable to this visitor.",
      }
    }
    log("success", `All ${pageCount} pages loaded`)

    // Strip toolbars and inject print CSS
    log("info", "Preparing document layout for PDF export...")
    await page.evaluate(() => {
      document.querySelector(".toolbar_top")?.remove()
      document.querySelector(".toolbar_bottom")?.remove()
      document.querySelectorAll<HTMLElement>(".document_scroller").forEach((el) => {
        el.style.position = "static"
        el.style.overflow = "visible"
        el.style.maxHeight = "none"
        el.style.height = "auto"
        el.style.margin = "0"
        el.style.padding = "0"
      })
      const style = document.createElement("style")
      style.textContent = `
        @media print {
          @page { margin: 0; }
          html, body { margin: 0 !important; padding: 0 !important; -webkit-print-color-adjust: exact !important; }
          .toolbar_top, .toolbar_bottom { display: none !important; }
          .document_scroller { position: static !important; overflow: visible !important; height: auto !important; max-height: none !important; }
          .outer_page { margin: 0 !important; break-inside: avoid !important; break-after: page !important; }
          .outer_page:last-of-type { break-after: auto !important; }
        }`
      document.head.appendChild(style)
    })

    // Wait for render stability (images loaded, page count settled)
    log("info", "Waiting for render to stabilize...")
    try {
      await page.evaluate(() => {
        return new Promise<void>((resolve) => {
          let stableCount = 0
          let last = ""
          const timeout = setTimeout(resolve, 20000)
          const check = () => {
            const state = JSON.stringify({
              imgs: Array.from(document.images || []).filter((i) => !i.complete).length,
              pgs: document.querySelectorAll(".outer_page, .newpage, [data-page-number], [data-page-index], [class~='page'], [class*='page_container'], [class*='page-wrapper']").length,
            })
            if (state === last) stableCount++
            else stableCount = 0
            last = state
            if (stableCount >= 3) {
              clearTimeout(timeout)
              resolve()
            } else {
              setTimeout(check, 300)
            }
          }
          const fontsReady = document.fonts?.ready ?? Promise.resolve()
          fontsReady.then(() => setTimeout(check, 500)).catch(() => setTimeout(check, 500))
        })
      })
    } catch {
      log("warn", "Render stability check timed out, proceeding anyway")
    }

    // Detect actual page dimensions for the PDF paper size
    const paper = await page.evaluate(() => {
      for (const s of [".outer_page", ".newpage", "[data-page-number]", "[data-page-index]", "[class~='page']", "[class*='page_container']", "[class*='page-wrapper']"]) {
        const el = document.querySelector(s)
        if (el) {
          const r = el.getBoundingClientRect()
          if (r.width > 0 && r.height > 0) return { w: r.width / 96, h: r.height / 96 }
        }
      }
      return null
    })
    const paperWidth = paper ? Math.max(1, Math.round(paper.w * 1000) / 1000) : 7.25
    const paperHeight = paper ? Math.max(1, Math.round(paper.h * 1000) / 1000) : 10.5
    log("info", `Detected page size: ${paperWidth.toFixed(2)}in x ${paperHeight.toFixed(2)}in`)

    const textLength = await page.evaluate(() => {
      const selectors = [".outer_page", ".newpage", "[data-page-number]", "[data-page-index]", "[class~='page']", "[class*='page_container']", "[class*='page-wrapper']"]
      const nodes = new Set<Element>()
      for (const selector of selectors) document.querySelectorAll(selector).forEach((node) => nodes.add(node))
      return Array.from(nodes).reduce((total, node) => total + (node.textContent?.trim().length ?? 0), 0)
    })
    const textSelectable = textLength > 20
    log(textSelectable ? "success" : "warn", textSelectable ? "The embed exposes selectable text" : "The embed exposes rendered pages only; the PDF will be image-based")

    log("step", "Exporting PDF via DevTools protocol...")
    await page.emulateMediaType("print")
    const pdfBuffer = Buffer.from(
      await page.pdf({
        landscape: false,
        displayHeaderFooter: false,
        printBackground: true,
        scale: 1,
        width: `${paperWidth}in`,
        height: `${paperHeight}in`,
        margin: { top: 0, bottom: 0, left: 0, right: 0 },
        preferCSSPageSize: false,
        timeout: 300000,
      }),
    )

    if (pdfBuffer.length < 1000) {
      return { error: "PDF export returned an empty result." }
    }
    const sizeMb = `${(pdfBuffer.length / 1024 / 1024).toFixed(1)} MB`
    log("success", `PDF exported: ${sizeMb}`)

    const delivery = await storeForDownload(pdfBuffer, title, "pdf", options, log, {
      sourceUrl: url,
      title,
      pages: pageCount,
      size: sizeMb,
      format: "pdf",
      platform: "scribd",
      textSelectable,
    })
    if ("error" in delivery) return delivery
    log("success", "PDF stored and ready for download")

    return {
      result: {
        id: delivery.id,
        title,
        pages: pageCount,
        size: sizeMb,
        format: "pdf",
        cachedUrl: delivery.cachedUrl,
        cachedExpiresAt: delivery.cachedExpiresAt,
        catboxUrl: delivery.catboxUrl,
        catboxExpiresAt: delivery.catboxExpiresAt,
        textSelectable,
        fileBase64: delivery.fileBase64,
      },
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error"
    return { error: `Browser error: ${msg}` }
  } finally {
    if (browser) {
      try {
        await browser.close()
      } catch {
        // ignore close errors
      }
    }
  }
}
