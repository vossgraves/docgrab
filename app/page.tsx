import { Downloader } from "@/components/downloader"
import { History } from "@/components/history"
import { SITE_URL } from "@/lib/site"

const GITHUB_URL = process.env.NEXT_PUBLIC_GITHUB_URL || "https://github.com/vossgraves/docgrab"

const faqs = [
  {
    question: "How do I download a SlideShare presentation as a PDF?",
    answer:
      "Copy the public SlideShare presentation URL, paste it into DocGrab, and start the job. DocGrab retrieves the highest-quality public slide assets it can find and creates a clean PDF. If the original public PDF or PPTX is exposed, it keeps that source file instead of rasterizing it.",
  },
  {
    question: "Can I download a public Scribd document?",
    answer:
      "Paste a public Scribd document URL into DocGrab. When the document’s public embed assets are available, DocGrab exports the accessible pages into a PDF. Text remains selectable when the source exposes a text layer; image-only pages cannot be converted into real text without inventing content.",
  },
  {
    question: "Can DocGrab find documents embedded in other public pages?",
    answer:
      "Yes. DocGrab can inspect a public document page for ordinary embedded PDF, PPTX, and presentation assets without clicking the page’s download controls. Results depend on the asset being publicly reachable and on the page exposing a usable file or embed reference.",
  },
  {
    question: "Is DocGrab free to use?",
    answer:
      "DocGrab is free to use and does not require an account. Use it only with documents you are allowed to access, copy, or download, and respect the source site’s terms and copyright restrictions.",
  },
]

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      name: "DocGrab",
      alternateName: "docgrab.vossgraves.cyou",
      url: SITE_URL,
    },
    {
      "@type": "WebApplication",
      "@id": `${SITE_URL}/#application`,
      name: "DocGrab",
      url: SITE_URL,
      applicationCategory: "UtilitiesApplication",
      operatingSystem: "Any",
      browserRequirements: "Requires JavaScript and a modern web browser.",
      description:
        "Download public SlideShare presentations, Scribd documents, and embedded PDF or PPTX files while preserving source text when it is available.",
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
      },
      featureList: [
        "Download public SlideShare presentations as PDF or PPTX when available",
        "Export accessible public Scribd documents as PDF",
        "Discover public PDF and PPTX assets embedded in document pages",
        "Preserve original public files and their text layers when exposed",
        "Live process log",
        "No account required",
      ],
    },
    {
      "@type": "FAQPage",
      "@id": `${SITE_URL}/#faq`,
      mainEntity: faqs.map(({ question, answer }) => ({
        "@type": "Question",
        name: question,
        acceptedAnswer: {
          "@type": "Answer",
          text: answer,
        },
      })),
    },
  ],
}

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55 0-.27-.01-1.17-.02-2.12-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.72-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.16 1.18a11 11 0 0 1 2.88-.39c.98 0 1.96.13 2.88.39 2.2-1.49 3.16-1.18 3.16-1.18.62 1.59.23 2.76.11 3.05.74.81 1.18 1.83 1.18 3.09 0 4.41-2.69 5.38-5.25 5.67.41.35.77 1.05.77 2.12 0 1.53-.01 2.76-.01 3.14 0 .31.2.67.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  )
}

export default function Home() {
  return (
    <main className="relative z-10 min-h-dvh flex flex-col">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <div className="mx-auto w-full max-w-3xl px-4 py-16 sm:py-24 flex-1 flex flex-col gap-8">
        <header className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="size-2 rounded-full bg-primary" />
            <span className="text-xs font-mono uppercase tracking-widest text-muted-foreground">docgrab</span>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto rounded-md border border-border bg-card p-2 text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
            >
              <GithubIcon className="size-4" />
              <span className="sr-only">View source on GitHub</span>
            </a>
          </div>
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-foreground text-balance">
            Download public documents as PDF or PPTX.
          </h1>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-xl text-pretty">
            Paste a SlideShare, Scribd, or public document-page link. DocGrab follows ordinary public assets without clicking download controls, preserves original PDF/PPTX files when available, and streams the process live.
          </p>
        </header>

        <Downloader />

        <History />

        <section aria-labelledby="how-it-works" className="border-t border-border pt-8 grid gap-6 sm:grid-cols-3">
          <div>
            <h2 id="how-it-works" className="text-sm font-medium text-foreground">How DocGrab works</h2>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Paste a public URL and DocGrab discovers the accessible document asset, retrieves the pages or original file, then returns a file you can save locally.
            </p>
          </div>
          <div>
            <h2 className="text-sm font-medium text-foreground">SlideShare and Scribd</h2>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              SlideShare downloads can use original PDF or PPTX assets when exposed. Public Scribd embeds are exported only when the page makes the required assets available.
            </p>
          </div>
          <div>
            <h2 className="text-sm font-medium text-foreground">Embedded documents</h2>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Public pages that embed a PDF or presentation can be inspected for ordinary file references without activating the page’s download buttons.
            </p>
          </div>
        </section>

        <section aria-labelledby="text-fidelity" className="border-t border-border pt-8">
          <h2 id="text-fidelity" className="text-sm font-medium text-foreground">Selectable text and file fidelity</h2>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground max-w-2xl">
            DocGrab keeps an original public PDF or PPTX when the source exposes one, which is the best path for preserving selectable text and editable presentation objects. If a source exposes only page images, the fallback PDF is necessarily image-based; it cannot create a reliable text layer that the source did not provide.
          </p>
        </section>

        <section aria-labelledby="faq" className="border-t border-border pt-8">
          <h2 id="faq" className="text-sm font-medium text-foreground">Frequently asked questions</h2>
          <div className="mt-4 divide-y divide-border border-y border-border">
            {faqs.map(({ question, answer }) => (
              <details key={question} className="group py-3">
                <summary className="cursor-pointer list-none pr-4 text-xs font-medium text-foreground marker:hidden">
                  <span className="group-open:text-primary">{question}</span>
                </summary>
                <p className="mt-2 max-w-2xl text-xs leading-relaxed text-muted-foreground">{answer}</p>
              </details>
            ))}
          </div>
        </section>

        <footer className="mt-auto pt-8 border-t border-border flex flex-col items-center gap-4">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-6 text-xs font-mono text-muted-foreground/60 text-center">
            <span>slideshare · original-or-rendered pipeline</span>
            <span>scribd · public embed export</span>
            <span>public pages · direct asset discovery</span>
            <span>local files auto-delete after 1h · catbox saves are permanent</span>
          </div>
          <p className="text-xs font-mono text-muted-foreground/70 text-center">
            Made by Mhsm with Claude Sonnet 4.5
          </p>
        </footer>
      </div>
    </main>
  )
}
