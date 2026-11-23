import { randomBytes } from "node:crypto"
import { lstat, readdir } from "node:fs/promises"
import { join } from "node:path"
import { downloadZip } from "client-zip"
import type { Config } from "./config"
import type { Db, Share } from "./db"
import { HttpError, PUBLIC_HEADERS, barePage, contentDisposition, escapeHtml, fileResponse, formatSize, json, listPage, readJson, type ListRow } from "./http"
import { listFolder } from "./files"
import { cleanRel, resolveExisting } from "./paths"
import { log } from "./otel"
import { thumbResponse } from "./thumbs"

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
export const ID_PATTERN = /^[0-9A-Za-z]{22}$/

// 128 random bits as 22 base62 characters.
export function newShareId() {
  let n = BigInt("0x" + randomBytes(16).toString("hex"))
  let out = ""
  while (n > 0n) {
    out = ALPHABET[Number(n % 62n)] + out
    n /= 62n
  }
  return out.padStart(22, "0")
}

// IPv4 as is; IPv6 by its /64, since one host usually owns a whole /64.
export function limitKey(ip: string) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  if (mapped) return mapped[1]
  if (!ip.includes(":")) return ip
  const [head, tail = ""] = ip.split("::")
  const left = head ? head.split(":") : []
  const right = tail ? tail.split(":") : []
  const groups = ip.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left
  return `${groups.slice(0, 4).map(g => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`
}

// Hits per client. Too many in a window and that client gets 429.
export function createLimiter(limit = 20, windowMs = 10 * 60_000) {
  const hits = new Map<string, { count: number; reset: number }>()
  let swept = Date.now()
  return {
    blocked(ip: string) {
      const hit = hits.get(limitKey(ip))
      return !!hit && hit.reset > Date.now() && hit.count >= limit
    },
    miss(ip: string) {
      const now = Date.now()
      if (now - swept > 60_000) {
        swept = now
        for (const [key, hit] of hits) if (hit.reset <= now) hits.delete(key)
      }
      const key = limitKey(ip)
      const hit = hits.get(key)
      if (!hit || hit.reset <= now) hits.set(key, { count: 1, reset: now + windowMs })
      else hit.count++
    },
  }
}

const shortId = (id: string) => id.slice(0, 4)

export function createShares(config: Config, db: Db) {
  const limiter = createLimiter()

  function active(share: Share, now = Date.now()) {
    return share.revoked_at === null && (share.expires_at === null || share.expires_at > now)
  }

  function view(share: Share) {
    return { id: share.id, path: share.path, url: `${config.shareOrigin}/${share.id}`, createdAt: share.created_at, expiresAt: share.expires_at, downloads: share.downloads, active: active(share) }
  }

  // Owner side, on the NAS host behind the session.
  async function handleOwner(req: Request, url: URL): Promise<Response> {
    const path = url.pathname
    if (path === "/api/shares" && req.method === "GET") {
      const filter = url.searchParams.has("path") ? cleanRel(url.searchParams.get("path")) : null
      const rows = (db.query("select * from shares where revoked_at is null order by created_at desc").all() as Share[])
        .filter(share => filter === null || share.path === filter)
      return json({ shares: rows.map(view) })
    }
    if (path === "/api/shares" && req.method === "POST") {
      const body = await readJson(req)
      const rel = cleanRel(body.path)
      if (!rel) throw new HttpError(400, "bad path")
      await resolveExisting(config.root, rel)
      const days = body.days
      if (days !== null && !(typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= 3650)) throw new HttpError(400, "bad days")
      const now = Date.now()
      const share: Share = { id: newShareId(), path: rel, created_at: now, expires_at: days === null ? null : now + days * 86_400_000, revoked_at: null, downloads: 0 }
      db.query("insert into shares (id, path, created_at, expires_at, revoked_at, downloads) values (?, ?, ?, ?, null, 0)").run(share.id, share.path, share.created_at, share.expires_at)
      log("share.create", { share: shortId(share.id), days: days ?? 0 })
      return json({ share: view(share) })
    }
    const match = /^\/api\/shares\/([0-9A-Za-z]{22})$/.exec(path)
    if (match && req.method === "DELETE") {
      const result = db.query("update shares set revoked_at = ? where id = ? and revoked_at is null").run(Date.now(), match[1])
      if (result.changes === 0) throw new HttpError(404)
      log("share.revoke", { share: shortId(match[1]) })
      return json({ ok: true })
    }
    throw new HttpError(404)
  }

  // Every failure looks the same from outside: missing, expired, revoked and deleted are one 404.
  async function resolve(id: string, sub: string | null, ip: string) {
    const share = ID_PATTERN.test(id) ? (db.query("select * from shares where id = ?").get(id) as Share | null) : null
    if (!share || !active(share)) {
      limiter.miss(ip)
      log("share.miss", {}, "WARN")
      throw new HttpError(404)
    }
    const base = await resolveExisting(config.root, share.path)
    const baseStat = await lstat(base)
    const rel = cleanRel(sub)
    if (rel && !baseStat.isDirectory()) throw new HttpError(404)
    const path = rel ? await resolveExisting(base, rel) : base
    const stat = rel ? await lstat(path) : baseStat
    if (!stat.isFile() && !stat.isDirectory()) throw new HttpError(404)
    return { share, path, rel, stat, name: rel ? rel.split("/").pop()! : share.path.split("/").pop()! }
  }

  async function* walk(dir: string, prefix: string): AsyncGenerator<{ name: string; input: Blob; lastModified: Date; size: number }> {
    for (const dirent of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, dirent.name)
      if (dirent.isDirectory()) yield* walk(path, `${prefix}${dirent.name}/`)
      else if (dirent.isFile()) {
        const stat = await lstat(path)
        yield { name: prefix + dirent.name, input: Bun.file(path), lastModified: stat.mtime, size: stat.size }
      }
    }
  }

  // Public side, on the share host. Returns null when the path is not a share route.
  async function handlePublic(req: Request, url: URL, ip: string): Promise<Response | null> {
    const match = /^\/([^/]+?)(\/raw|\/zip|\/thumb)?$/.exec(url.pathname)
    // Only well-formed ids count as attempts; /favicon.ico and the like are a plain 404.
    if (!match || !ID_PATTERN.test(match[1])) return null
    const [, id, suffix] = match
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405)
    if (limiter.blocked(ip)) {
      log("share.throttled", {}, "WARN")
      throw new HttpError(429)
    }
    const found = await resolve(id, url.searchParams.get("path"), ip)

    // A small webp of an image or of a PDF's first page, for the folder list. Other files have none.
    if (suffix === "/thumb") {
      if (!found.stat.isFile()) throw new HttpError(404)
      return thumbResponse(found.path, found.stat.size, PUBLIC_HEADERS)
    }

    // Video, audio and images fill the window in a bare player page.
    const mime = Bun.file(found.path).type.split(";")[0]
    const media = /^(video|audio)\//.test(mime) || (mime.startsWith("image/") && mime !== "image/svg+xml")
    if (!suffix && found.stat.isFile() && media) {
      if (req.method === "GET") {
        db.query("update shares set downloads = downloads + 1 where id = ?").run(found.share.id)
        log("share.view", { share: shortId(found.share.id), kind: mime.split("/")[0], sub: !!found.rel })
      }
      const src = escapeHtml(`/${id}/raw${found.rel ? `?path=${encodeURIComponent(found.rel)}` : ""}`)
      const tag = mime.startsWith("image/")
        ? `<img src="${src}" alt="">`
        : mime.startsWith("video/")
          ? `<video src="${src}" controls playsinline preload="metadata"></video>`
          : `<audio src="${src}" controls preload="metadata"></audio>`
      return barePage(found.name, tag, 200, "html,body{margin:0;height:100%;background:#000}img,video{display:block;width:100vw;height:100vh;object-fit:contain}audio{display:block;width:100%;position:absolute;top:50%;transform:translateY(-50%)}")
    }

    // Any other file opens as itself, so the browser shows it with its own viewer.
    if (suffix !== "/zip" && found.stat.isFile()) {
      const result = fileResponse(req, found.path, found.name, found.stat.size, url.searchParams.get("dl") === "1", PUBLIC_HEADERS)
      if (req.method === "GET" && result.response.status < 300 && !result.partial) {
        db.query("update shares set downloads = downloads + 1 where id = ?").run(found.share.id)
        log("share.download", { share: shortId(found.share.id), bytes: found.stat.size, sub: !!found.rel })
      }
      return result.response
    }

    if (suffix === "/raw") throw new HttpError(404)
    if (!found.stat.isDirectory()) throw new HttpError(404)

    if (suffix !== "/zip") {
      const entries = await listFolder(found.path)
      const href = (rel: string) => (rel ? `?path=${encodeURIComponent(rel)}` : `/${id}`)
      const sub = (rel: string) => encodeURIComponent(rel)
      const rows: ListRow[] = [
        ...(found.rel ? [{ href: href(found.rel.split("/").slice(0, -1).join("/")), name: "..", note: "", label: "<" }] : []),
        ...entries.map(entry => {
          const rel = [found.rel, entry.name].filter(Boolean).join("/")
          if (entry.type === "folder") return { href: href(rel), name: entry.name + "/", note: "", label: "/" }
          return {
            href: href(rel),
            name: entry.name,
            note: formatSize(entry.size),
            label: (entry.name.split(".").pop() ?? "").slice(0, 4).toUpperCase(),
            thumb: entry.thumb ? `/${id}/thumb?path=${sub(rel)}` : undefined,
            download: `/${id}?path=${sub(rel)}&dl=1`,
          }
        }),
      ]
      return listPage(found.name, rows, `/${id}/zip${found.rel ? `?path=${encodeURIComponent(found.rel)}` : ""}`)
    }

    if (req.method === "GET") {
      db.query("update shares set downloads = downloads + 1 where id = ?").run(found.share.id)
      log("share.zip", { share: shortId(found.share.id), sub: !!found.rel })
    }
    const response = downloadZip(walk(found.path, ""))
    const headers = new Headers(response.headers)
    for (const [k, v] of Object.entries(PUBLIC_HEADERS)) headers.set(k, v)
    headers.set("content-disposition", contentDisposition("attachment", `${found.name}.zip`))
    headers.set("cache-control", "no-store")
    return new Response(response.body, { status: 200, headers })
  }

  return { handleOwner, handlePublic }
}
