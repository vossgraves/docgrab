import PptxGenJS from "pptxgenjs"
import { getJpegDimensions } from "./pdf"

/**
 * Build a PPTX presentation from JPEG slide buffers.
 * Each slide image fills the whole slide, with the slide aspect ratio
 * matched to the first image so nothing is stretched.
 */
export async function buildPptxFromJpegs(jpegs: Buffer[]): Promise<Buffer | null> {
  if (jpegs.length === 0) return null

  const pptx = new PptxGenJS()

  // Match the deck aspect ratio to the first slide's dimensions.
  const first = getJpegDimensions(jpegs[0]) ?? { width: 638, height: 479 }
  const ratio = first.height / first.width
  const slideWidthIn = 10
  const slideHeightIn = Math.round(slideWidthIn * ratio * 100) / 100

  pptx.defineLayout({ name: "DOCGRAB", width: slideWidthIn, height: slideHeightIn })
  pptx.layout = "DOCGRAB"

  for (const jpeg of jpegs) {
    const slide = pptx.addSlide()
    const base64 = `data:image/jpeg;base64,${jpeg.toString("base64")}`
    slide.addImage({
      data: base64,
      x: 0,
      y: 0,
      w: slideWidthIn,
      h: slideHeightIn,
    })
  }

  // pptxgenjs can return a Node Buffer when write is called with nodebuffer output.
  const out = (await pptx.write({ outputType: "nodebuffer" })) as Buffer
  return Buffer.isBuffer(out) ? out : Buffer.from(out)
}
