import { mkdirSync } from "node:fs"
import { lstat } from "node:fs/promises"
import { join } from "node:path"
import { createAuth } from "./auth"
import type { Config } from "./config"
import { openDb } from "./db"
import { createFiles } from "./files"
import { HttpError, barePage, json } from "./http"
import { log } from "./otel"
import { cleanRel, within } from "./paths"
import { createShares } from "./shares"

const APP_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"

export function createApp(config: Config) {
  for (const dir of [config.data, config.root, config.tmp]) mkdirSync(dir, { recursive: true })
  const db = openDb(join(config.data, "nas.db"))
  const auth = createAuth(config, db)
  const files = createFiles(config, db)
  const shares = createShares(config, db)
  const nasHost = new URL(config.origin).host
  const shareHost = new URL(config.shareOrigin).host

  // The owner SPA and its hashed assets.
  async function serveStatic(pathname: string) {
    let decoded: string
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      throw new HttpError(400, "bad path")
    }
    const rel = cleanRel(decoded)
    const asset = rel.startsWith("assets/") || /^[\w.-]+\.(ico|png|svg|webmanifest)$/.test(rel)
    const path = asset ? join(config.dist, rel) : join(config.dist, "index.html")
    if (!within(config.dist, path) || !(await lstat(path).then(s => s.isFile(), () => false))) throw new HttpError(404)
    const headers = new Headers({
      "content-security-policy": APP_CSP,
      "x-content-type-options": "nosniff",
      "cache-control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    })
    return new Response(Bun.file(path), { headers })
  }

  async function route(req: Request, ip: string): Promise<Response> {
    const url = new URL(req.url)
    const host = req.headers.get("host")

    if (host === shareHost) {
      const response = await shares.handlePublic(req, url, ip)
      if (response) return response
      // The share host has no home page of its own.
      if (url.pathname === "/") return Response.redirect("https://www.zyx.tw/", 302)
      throw new HttpError(404)
    }

    if (host !== nasHost) throw new HttpError(421)

    if (url.pathname.startsWith("/api/")) {
      // Cookies are SameSite=Strict; the Origin check covers older browsers and non-browser clients.
      if (req.method !== "GET" && req.method !== "HEAD" && req.headers.get("origin") !== config.origin) throw new HttpError(403)
      if (url.pathname.startsWith("/api/auth/")) return auth.handle(req, url.pathname, ip)
      if (!auth.session(req)) throw new HttpError(401)
      if (url.pathname.startsWith("/api/files")) return files.handle(req, url)
      if (url.pathname.startsWith("/api/shares")) return shares.handleOwner(req, url)
      throw new HttpError(404)
    }
    return serveStatic(url.pathname)
  }

  async function fetch(req: Request, ip = "unknown"): Promise<Response> {
    const started = performance.now()
    let response: Response
    try {
      response = await route(req, ip)
    } catch (error) {
      if (error instanceof HttpError && req.headers.get("host") === shareHost) {
        response = barePage("連結無效", error.status === 429 ? "請稍後再試" : "連結無效", error.status)
      } else if (error instanceof HttpError) {
        response = json({ error: error.message || String(error.status) }, { status: error.status })
      } else {
        log("http.error", { error: String(error), path: new URL(req.url).pathname.startsWith("/api/") ? new URL(req.url).pathname : "page" }, "ERROR")
        response = json({ error: "internal" }, { status: 500 })
      }
    }
    if (response.status >= 500) log("http.5xx", { status: response.status, ms: Math.round(performance.now() - started) }, "ERROR")
    return response
  }

  return { fetch, db }
}
