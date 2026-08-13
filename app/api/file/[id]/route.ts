import type { NextRequest } from "next/server"
import { getFile } from "@/lib/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const file = await getFile(id)

  if (!file) {
    return Response.json({ error: "File not found or expired" }, { status: 404 })
  }

  return new Response(new Uint8Array(file.buffer), {
    headers: {
      "Content-Type": CONTENT_TYPES[file.ext] ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename="${id}.${file.ext}"`,
      "Content-Length": String(file.buffer.length),
      // File ids are random and the underlying temp file expires after one hour.
      // Edge caching removes repeat reads from the function while retaining a
      // bounded lifetime for generated content.
      "Cache-Control": "public, max-age=3600, s-maxage=3600, stale-while-revalidate=60",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
