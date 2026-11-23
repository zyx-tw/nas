import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HttpError } from "./http"

// Small webp thumbnails for file lists: images, and a PDF's first page.
const IMAGE_TYPE = /^image\/(png|jpeg|webp|gif|avif|heic)$/
const MAX_BYTES = 40 * 1024 * 1024
const FALLBACK_BYTES = 2 * 1024 * 1024
// pdftoppm comes from poppler-utils; a host without it shows no PDF thumbnails.
const PDFTOPPM = Bun.which("pdftoppm")
const PDF_RENDER_MS = 10_000

const mimeOf = (name: string) => Bun.file(name).type.split(";")[0]

export function hasThumb(name: string, size: number) {
  if (size > MAX_BYTES) return false
  const mime = mimeOf(name)
  return IMAGE_TYPE.test(mime) || (mime === "application/pdf" && !!PDFTOPPM)
}

// pdftoppm 26 writes nothing to stdout, so it draws into a private temp dir.
async function pdfFirstPage(path: string): Promise<Uint8Array | null> {
  if (!PDFTOPPM) return null
  const dir = await mkdtemp(join(tmpdir(), "nas-pdf-"))
  try {
    const out = join(dir, "page")
    const proc = Bun.spawn([PDFTOPPM, "-f", "1", "-l", "1", "-singlefile", "-scale-to", "480", "-png", path, out], {
      stdout: "ignore",
      stderr: "ignore",
      timeout: PDF_RENDER_MS,
    })
    if ((await proc.exited) !== 0) return null
    const png = Bun.file(out + ".png")
    return (await png.exists()) ? await png.bytes() : null
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const shrink = (bytes: Uint8Array) => new Bun.Image(bytes).resize(240, 240, { fit: "inside" }).webp({ quality: 80 }).bytes().catch(() => null)

// The thumbnail of a regular file, or a 404 when it has none.
export async function thumbResponse(path: string, size: number, headers: Record<string, string> = {}): Promise<Response> {
  if (!hasThumb(path, size)) throw new HttpError(404)
  const mime = mimeOf(path)
  const reply = (body: Uint8Array, type: string) =>
    new Response(body, { headers: { ...headers, "content-type": type, "x-content-type-options": "nosniff", "cache-control": "private, max-age=300" } })
  if (mime === "application/pdf") {
    const page = await pdfFirstPage(path)
    const thumb = page && (await shrink(page))
    if (!thumb) throw new HttpError(404)
    return reply(thumb, "image/webp")
  }
  const source = await Bun.file(path).bytes()
  const thumb = await shrink(source)
  if (thumb) return reply(thumb, "image/webp")
  // A file the decoder rejects, such as a truncated JPEG, still shows in a browser: send a small one as it is.
  if (source.length > FALLBACK_BYTES) throw new HttpError(404)
  return reply(source, mime)
}
