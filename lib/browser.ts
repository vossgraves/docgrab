import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { getUserAgent } from "./user-agent"
import type { Logger } from "./types"

/**
 * Launch a normal headless Chrome/Chromium for public pages that require
 * client-side rendering. It does not attempt to defeat authentication,
 * paywalls, CAPTCHAs, or anti-bot controls. Local Chromium is preferred,
 * then the serverless chromium build.
 */
export async function launchBrowser(log: Logger) {
  const puppeteer = await import("puppeteer-core")

  const localCandidates = [
    process.env.CHROME_PATH,
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/homebrew/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean) as string[]

  const commonArgs = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--hide-scrollbars",
  ]

  for (const path of localCandidates) {
    if (existsSync(path)) {
      log("info", `Launching local Chromium: ${path}`)
      return puppeteer.launch({
        executablePath: path,
        headless: true,
        args: commonArgs,
        // deviceScaleFactor: 2 renders pages at 2x resolution so image-based
        // documents (e.g. Scribd) export as crisp, high-quality PDFs.
        defaultViewport: { width: 1600, height: 2200, deviceScaleFactor: 2 },
      })
    }
  }

  log("info", "No local Chromium found, using serverless chromium build...")
  const chromium = (await import("@sparticuz/chromium")).default
  let executablePath: string
  try {
    executablePath = await chromium.executablePath()
  } catch (error) {
    // Next/Vercel can preserve either a flat external package path or the
    // pnpm store path. If tracing kept the package but its default ESM path
    // points at a relocated directory, pass the existing bin folder directly.
    const binCandidates = [
      join(process.cwd(), "node_modules/@sparticuz/chromium/bin"),
      join(process.cwd(), "node_modules/.pnpm/@sparticuz+chromium@149.0.0/node_modules/@sparticuz/chromium/bin"),
      "/var/task/node_modules/@sparticuz/chromium/bin",
      "/var/task/node_modules/.pnpm/@sparticuz+chromium@149.0.0/node_modules/@sparticuz/chromium/bin",
    ]

    try {
      const pnpmRoot = join(process.cwd(), "node_modules/.pnpm")
      for (const entry of readdirSync(pnpmRoot)) {
        if (entry.startsWith("@sparticuz+chromium@")) {
          binCandidates.push(join(pnpmRoot, entry, "node_modules/@sparticuz/chromium/bin"))
        }
      }
    } catch {
      // Flat node_modules layouts do not have a pnpm store directory.
    }

    const tracedBin = binCandidates.find((candidate) => existsSync(candidate))
    if (!tracedBin) throw error
    log("info", `Using traced Chromium assets from: ${tracedBin}`)
    executablePath = await chromium.executablePath(tracedBin)
  }

  return puppeteer.launch({
    executablePath,
    headless: true,
    args: [...chromium.args, ...commonArgs],
    defaultViewport: { width: 1600, height: 2200, deviceScaleFactor: 2 },
  })
}

/**
 * Fetch a page's fully rendered HTML using normal headless Chrome for
 * public client-rendered pages.
 */
export async function fetchHtmlWithBrowser(
  url: string,
  log: Logger,
  timeoutMs = 60000,
  readySelector?: string,
  readyTimeoutMs = 20000,
): Promise<string | null> {
  let browser: Awaited<ReturnType<typeof launchBrowser>> | null = null
  try {
    browser = await launchBrowser(log)
    const page = await browser.newPage()
    await page.setUserAgent(getUserAgent())
    page.setDefaultTimeout(timeoutMs)
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs })
    try {
      await page.waitForFunction(() => Boolean(document.body?.innerHTML.length), { timeout: 10000 })
    } catch {
      log("warn", "Public page did not finish rendering before the timeout")
    }
    if (readySelector) {
      try {
        await page.waitForSelector(readySelector, { timeout: Math.min(timeoutMs, readyTimeoutMs) })
      } catch {
        log("warn", `Public page did not expose the expected asset marker: ${readySelector}`)
      }
    }
    return await page.content()
  } catch (e) {
    log("warn", `Browser fetch failed: ${e instanceof Error ? e.message : "unknown error"}`)
    return null
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
