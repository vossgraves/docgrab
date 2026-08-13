# DocGrab

DocGrab is a Next.js App Router application for processing **publicly accessible** SlideShare, Scribd, and ordinary document pages. The project starts from the `docgrab-mhsm` implementation and adds source-aware document handling, safer serverless delivery, and direct public-asset discovery for sites such as educational worksheet pages.

## Supported source behavior

SlideShare and Scribd remain supported through their public page or embed content. When a source page exposes an ordinary original PDF or PPTX asset, DocGrab retrieves that asset and preserves the source text or editable presentation objects. When a platform exposes only rendered slide/page images, DocGrab creates an explicit raster fallback and reports that selectable text was not available from the source; it does not mislabel an image-only export as text-selectable.

For other public pages, paste the page URL or direct PDF/PPTX URL. DocGrab scans ordinary HTML attributes, document metadata, iframes, embeds, and direct asset references for public `.pdf`, `.ppt`, and `.pptx` candidates. It does not click download buttons, invoke hidden UI actions, bypass authentication or paywalls, defeat CAPTCHAs or anti-bot controls, or retrieve DRM-protected files. Legacy `.ppt` files are reported rather than converted automatically; public PDF and PPTX assets are preserved as-is.

## Local development

Install the locked dependencies and start the development server:

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). Before submitting changes, run:

```bash
pnpm build
```

TypeScript build errors are intentionally not ignored in `next.config.mjs`, so a deployment fails rather than shipping an invalid API route.

## Vercel deployment notes

The download API streams NDJSON progress and is configured with a five-minute function duration where the selected Vercel plan permits it. The browser fallback uses `puppeteer-core` and `@sparticuz/chromium`, with the relevant Chromium and WASM assets included in the server bundle. The implementation uses `domcontentloaded` rather than waiting for network idle, bounded source and browser timeouts, limited concurrent SlideShare image fetches, and no duplicate page fetch when HTML is already available.

Generated files are written to the instance temporary directory for up to one hour. Small files may be sent inline for instant client-side download; files larger than 3 MB use the file route instead of duplicating the bytes as base64 in the progress response. The file route uses a random id and a one-hour cache policy so repeat downloads can be served by Vercel’s edge cache after the first successful response. The temporary directory itself is not durable or shared between function instances, so a persistent external link should be enabled when that guarantee is required.

The relevant upstream reference is [Vercel function duration configuration](https://vercel.com/docs/functions/configuring-functions/duration). If the deployment plan imposes a lower maximum duration, large browser-rendered documents may need to be limited or moved to a persistent worker.

## Optional storage

The “Save to catbox.moe” option uploads the generated file after processing. Without a userhash, the anonymous link is temporary; with a userhash, the user’s catbox account controls retention. This storage behavior is separate from the local one-hour temporary file used for the immediate download route.
