/**
 * Pure TypeScript PDF builder from JPEG buffers.
 * No external dependencies — embeds JPEGs with DCTDecode filter.
 */

export function getJpegDimensions(data: Buffer): { width: number; height: number } | null {
  if (data.length < 10 || data[0] !== 0xff || data[1] !== 0xd8) return null
  let i = 2
  while (i < data.length - 9) {
    if (data[i] !== 0xff) {
      i += 1
      continue
    }
    const marker = data[i + 1]
    if (marker === 0xd9 || marker === 0xda) break
    // SOF0-SOF3 markers contain dimensions
    if (marker >= 0xc0 && marker <= 0xc3) {
      const height = data.readUInt16BE(i + 5)
      const width = data.readUInt16BE(i + 7)
      return { width, height }
    }
    if (i + 3 < data.length) {
      const length = data.readUInt16BE(i + 2)
      i += 2 + length
    } else {
      break
    }
  }
  return null
}

export function isJpeg(data: Buffer): boolean {
  return data.length > 2 && data[0] === 0xff && data[1] === 0xd8
}

export function buildPdfFromJpegs(jpegs: Buffer[]): Buffer | null {
  if (jpegs.length === 0) return null

  const chunks: Buffer[] = []
  let position = 0
  const offsets = new Map<number, number>()

  const push = (data: Buffer | string) => {
    const buf = typeof data === "string" ? Buffer.from(data, "latin1") : data
    chunks.push(buf)
    position += buf.length
  }

  push("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")

  const catalogRef = 1
  const pagesRef = 2
  let objCounter = 3

  const pageEntries = jpegs.map((img) => {
    const dims = getJpegDimensions(img) ?? { width: 638, height: 479 }
    const pageObj = objCounter
    const xobjObj = objCounter + 1
    const contentObj = objCounter + 2
    objCounter += 3
    return { pageObj, xobjObj, contentObj, data: img, w: dims.width, h: dims.height }
  })

  const writeObj = (num: number, body: Buffer | string) => {
    offsets.set(num, position)
    push(`${num} 0 obj\n`)
    push(body)
    push("\nendobj\n")
  }

  writeObj(catalogRef, `<< /Type /Catalog /Pages ${pagesRef} 0 R >>`)
  const kids = pageEntries.map((p) => `${p.pageObj} 0 R`).join(" ")
  writeObj(pagesRef, `<< /Type /Pages /Kids [${kids}] /Count ${pageEntries.length} >>`)

  for (const pg of pageEntries) {
    const contentStream = Buffer.from(`q ${pg.w} 0 0 ${pg.h} 0 0 cm /Img Do Q`, "latin1")
    writeObj(
      pg.pageObj,
      `<< /Type /Page /Parent ${pagesRef} 0 R /MediaBox [0 0 ${pg.w} ${pg.h}] ` +
        `/Contents ${pg.contentObj} 0 R /Resources << /XObject << /Img ${pg.xobjObj} 0 R >> >> >>`,
    )

    offsets.set(pg.xobjObj, position)
    push(
      `${pg.xobjObj} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pg.w} /Height ${pg.h} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pg.data.length} >>\nstream\n`,
    )
    push(pg.data)
    push("\nendstream\nendobj\n")

    writeObj(
      pg.contentObj,
      Buffer.concat([
        Buffer.from(`<< /Length ${contentStream.length} >>\nstream\n`, "latin1"),
        contentStream,
        Buffer.from("\nendstream", "latin1"),
      ]),
    )
  }

  const xrefPos = position
  push(`xref\n0 ${objCounter}\n`)
  push("0000000000 65535 f \n")
  for (let i = 1; i < objCounter; i++) {
    const off = offsets.get(i) ?? 0
    push(`${off.toString().padStart(10, "0")} 00000 ${offsets.has(i) ? "n" : "f"} \n`)
  }
  push(`trailer\n<< /Size ${objCounter} /Root ${catalogRef} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`)

  return Buffer.concat(chunks)
}
