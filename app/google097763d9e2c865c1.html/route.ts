export async function GET() {
  return new Response("google-site-verification: google097763d9e2c865c1", {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  })
}
