export class HttpError extends Error {
  readonly status: number
  constructor(status: number, message = "") {
    super(message)
    this.status = status
  }
}

export type HeaderMap = Record<string, string>

export function json(body: unknown, init: { status?: number; headers?: HeaderMap | Headers } = {}) {
  const headers = new Headers(init.headers)
  headers.set("content-type", "application/json; charset=utf-8")
  headers.set("cache-control", "no-store")
  return new Response(JSON.stringify(body), { ...init, headers })
}

const MAX_JSON = 64 * 1024

// Reads at most 64 KB, so an anonymous POST cannot fill memory.
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_JSON) throw new HttpError(413)
  const chunks: Uint8Array[] = []
  let size = 0
  if (req.body) {
    for await (const chunk of req.body) {
      size += chunk.byteLength
      if (size > MAX_JSON) throw new HttpError(413)
      chunks.push(chunk)
    }
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>
  } catch {
    // Fall through to the 400 below.
  }
  throw new HttpError(400, "bad json")
}

// Types a browser may render in place. Everything else downloads, so a shared
// HTML or SVG file never runs as a page.
export function inlineSafe(type: string) {
  const mime = type.split(";")[0].trim().toLowerCase()
  if (mime === "image/svg+xml") return false
  return /^(image|video|audio)\//.test(mime) || mime === "application/pdf" || mime === "text/plain"
}

export function contentDisposition(kind: "inline" | "attachment", name: string) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_")
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

// One byte range from a Range header, or null for the whole file.
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | "invalid" {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (match[1] === "" && match[2] === "")) return "invalid"
  if (match[1] === "") {
    const suffix = Number(match[2])
    if (suffix === 0) return "invalid"
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(match[1])
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1)
  if (start >= size || end < start) return "invalid"
  return { start, end }
}

export const PUBLIC_HEADERS = { "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" }

export function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`)
}

// A plain page with the browser's own look: no app, no scripts.
const BARE_STYLE = "body{font:16px/1.6 system-ui,sans-serif;margin:16px}ul{list-style:none;padding:0;margin:0}a{color:inherit}"

export function barePage(title: string, body: string, status = 200, style = BARE_STYLE) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)}</title><style>${style}</style></head><body>${body}</body></html>`
  return new Response(html, {
    status,
    headers: {
      ...PUBLIC_HEADERS,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  })
}

const LIST_STYLE = `:root{color-scheme:light dark;--bg:oklch(0.97 0.005 85);--fg:oklch(0.25 0 0);--muted:oklch(0.52 0 0)}
@media (prefers-color-scheme:dark){:root{--bg:oklch(0.17 0 0);--fg:oklch(0.88 0 0);--muted:oklch(0.62 0 0)}}
html,body{margin:0;min-height:100%;background:var(--bg);color:var(--fg);font:16px/24px "Maple Mono NF CN",ui-monospace,monospace}
a{color:inherit;text-decoration:none}
.corner{position:fixed;top:16px;text-transform:uppercase;font-size:14px;line-height:20px;color:var(--muted)}
.corner:hover{color:var(--fg)}
.left{left:16px}.right{right:16px}
main{max-width:640px;margin:0 auto;padding:96px 16px 64px}
h1{margin:0 0 32px;font-size:24px;line-height:32px;font-weight:600;overflow-wrap:anywhere}
ul{margin:0;padding:0;list-style:none}
li{display:flex;align-items:center;gap:16px;padding:8px 0}
.thumb{flex:none;display:flex;align-items:center;justify-content:center;width:80px;height:80px;font-size:14px;color:var(--muted)}
.thumb img{display:block;max-width:100%;max-height:100%}
.name{flex:1;min-width:0;padding:4px 8px;margin:0 -8px}
.name span{display:block;overflow-wrap:anywhere}
.name .note{font-size:14px;color:var(--muted)}
.name:hover{background:var(--fg);color:var(--bg)}
.name:hover .note{color:var(--bg)}
.dl{flex:none;font-size:14px;color:var(--muted);padding:4px 8px;margin:0 -8px}
.dl:hover{background:var(--fg);color:var(--bg)}`

export type ListRow = { href: string; name: string; note: string; label: string; thumb?: string; download?: string }

// The folder list for a share link: ui.zyx.tw look, a font and a stylesheet from ui.zyx.tw, still no script.
export function listPage(title: string, rows: ListRow[], zipHref: string) {
  const items = rows
    .map(row => {
      const mark = row.thumb ? `<img src="${escapeHtml(row.thumb)}" alt="" loading="lazy">` : escapeHtml(row.label)
      const note = row.note ? `<span class="note">${escapeHtml(row.note)}</span>` : ""
      const download = row.download ? `<a class="dl" href="${escapeHtml(row.download)}">[ download ]</a>` : ""
      return `<li><a class="thumb" href="${escapeHtml(row.href)}" tabindex="-1">${mark}</a><a class="name" href="${escapeHtml(row.href)}"><span>${escapeHtml(row.name)}</span>${note}</a>${download}</li>`
    })
    .join("")
  const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="https://ui.zyx.tw/fonts/maple-mono-nf-cn.css"><style>${LIST_STYLE}</style></head><body><span class="corner left">s.zyx.tw</span><a class="corner right" href="${escapeHtml(zipHref)}">[ zip ]</a><main><h1>${escapeHtml(title)}</h1><ul>${items}</ul></main></body></html>`
  return new Response(html, {
    headers: {
      ...PUBLIC_HEADERS,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline' https://ui.zyx.tw; font-src https://ui.zyx.tw; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  })
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++ }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`
}

export const FILE_CSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'"

export function fileResponse(req: Request, path: string, name: string, size: number, download: boolean, extra: HeaderMap = {}) {
  const file = Bun.file(path)
  const type = file.type || "application/octet-stream"
  const headers = new Headers(extra)
  headers.set("content-type", type)
  headers.set("accept-ranges", "bytes")
  const inline = !download && inlineSafe(type)
  headers.set("content-disposition", contentDisposition(inline ? "inline" : "attachment", name))
  // Only downloads get the sandbox. Inline types cannot run script, and Safari's
  // media viewer and Chrome's PDF viewer both break inside a sandboxed document.
  if (!inline) headers.set("content-security-policy", FILE_CSP)
  headers.set("x-content-type-options", "nosniff")
  headers.set("cache-control", "private, no-cache")
  const range = parseRange(req.headers.get("range"), size)
  if (range === "invalid") {
    headers.set("content-range", `bytes */${size}`)
    return { response: new Response(null, { status: 416, headers }), bytes: 0, partial: true }
  }
  if (req.method === "HEAD") {
    headers.set("content-length", String(size))
    return { response: new Response(null, { status: 200, headers }), bytes: 0, partial: false }
  }
  if (range) {
    headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`)
    headers.set("content-length", String(range.end - range.start + 1))
    return { response: new Response(file.slice(range.start, range.end + 1), { status: 206, headers }), bytes: range.end - range.start + 1, partial: true }
  }
  headers.set("content-length", String(size))
  return { response: new Response(file, { status: 200, headers }), bytes: size, partial: false }
}
