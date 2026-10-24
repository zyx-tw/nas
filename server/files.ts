import { createWriteStream } from "node:fs"
import { link, lstat, mkdir, readdir, rename, rm, unlink } from "node:fs/promises"
import { join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { randomBytes } from "node:crypto"
import type { Config } from "./config"
import type { Db, Share } from "./db"
import { HttpError, fileResponse, json, readJson } from "./http"
import { cleanRel, resolveExisting, resolveNew } from "./paths"
import { log } from "./otel"
import { createSizes } from "./sizes"

export type Entry = { name: string; type: "file" | "folder"; size: number; modified: number }

// Files and folders only; symlinks and special files stay hidden.
// Folders get their size from folderSize when it is given, else 0.
export async function listFolder(dir: string, folderSize?: (name: string) => Promise<number>): Promise<Entry[]> {
  const entries: Entry[] = []
  for (const dirent of await readdir(dir, { withFileTypes: true })) {
    if (!dirent.isFile() && !dirent.isDirectory()) continue
    const stat = await lstat(join(dir, dirent.name)).catch(() => null)
    if (!stat) continue
    entries.push({ name: dirent.name, type: dirent.isDirectory() ? "folder" : "file", size: dirent.isDirectory() ? ((await folderSize?.(dirent.name)) ?? 0) : stat.size, modified: stat.mtimeMs })
  }
  return entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, "zh-Hant") : a.type === "folder" ? -1 : 1))
}

export function createFiles(config: Config, db: Db) {
  const under = (path: string, rel: string) => path === rel || path.startsWith(rel + "/")
  const sizes = createSizes(config.root, db)
  sizes.start()

  async function upload(req: Request, rel: string, overwrite: boolean) {
    if (!req.body) throw new HttpError(400, "empty body")
    let target: string
    if (overwrite) {
      target = await resolveNew(config.root, rel).catch(async error => {
        if (error instanceof HttpError && error.status === 409) {
          const existing = await resolveExisting(config.root, rel)
          if (!(await lstat(existing)).isFile()) throw new HttpError(409, "exists")
          return existing
        }
        throw error
      })
    } else {
      target = await resolveNew(config.root, rel)
    }
    const tmp = join(config.tmp, randomBytes(12).toString("hex"))
    try {
      await pipeline(Readable.fromWeb(req.body as never), createWriteStream(tmp, { flags: "wx" }))
      if (overwrite) {
        await rename(tmp, target)
      } else {
        // link fails if the name was taken meanwhile, so an upload never replaces a file silently.
        await link(tmp, target).catch(error => {
          throw error?.code === "EEXIST" ? new HttpError(409, "exists") : error
        })
        await unlink(tmp)
      }
    } catch (error) {
      await unlink(tmp).catch(() => {})
      throw error
    }
    sizes.changed(rel)
    const size = (await lstat(target)).size
    log("file.upload", { bytes: size, overwrite })
    return json({ ok: true, size })
  }

  async function handle(req: Request, url: URL): Promise<Response> {
    const path = url.pathname

    if (path === "/api/files" && req.method === "GET") {
      const rel = cleanRel(url.searchParams.get("path"))
      const dir = await resolveExisting(config.root, rel)
      if (!(await lstat(dir)).isDirectory()) throw new HttpError(400, "not a folder")
      return json({ path: rel, entries: await listFolder(dir, name => sizes.get(rel ? `${rel}/${name}` : name)) })
    }

    if (path === "/api/files/content" && (req.method === "GET" || req.method === "HEAD")) {
      const rel = cleanRel(url.searchParams.get("path"))
      const file = await resolveExisting(config.root, rel)
      const stat = await lstat(file)
      if (!stat.isFile()) throw new HttpError(404)
      return fileResponse(req, file, rel.split("/").pop()!, stat.size, url.searchParams.get("dl") === "1").response
    }

    if (path === "/api/files/content" && req.method === "PUT") {
      return upload(req, cleanRel(url.searchParams.get("path")), url.searchParams.get("overwrite") === "1")
    }

    if (path === "/api/files/folder" && req.method === "POST") {
      const rel = cleanRel((await readJson(req)).path)
      await mkdir(await resolveNew(config.root, rel))
      sizes.changed(rel)
      log("file.folder")
      return json({ ok: true })
    }

    if (path === "/api/files/move" && req.method === "POST") {
      const body = await readJson(req)
      const from = cleanRel(body.from)
      const to = cleanRel(body.to)
      if (!from || under(to, from)) throw new HttpError(400, "bad move")
      const source = await resolveExisting(config.root, from)
      await rename(source, await resolveNew(config.root, to))
      sizes.removed(from)
      sizes.changed(to)
      // Links follow the file: rewrite every share at or below the old path.
      const shares = db.query("select id, path from shares").all() as Pick<Share, "id" | "path">[]
      const update = db.query("update shares set path = ? where id = ?")
      db.transaction(() => {
        for (const share of shares) if (under(share.path, from)) update.run(to + share.path.slice(from.length), share.id)
      })()
      log("file.move")
      return json({ ok: true })
    }

    if (path === "/api/files" && req.method === "DELETE") {
      const rel = cleanRel(url.searchParams.get("path"))
      if (!rel) throw new HttpError(400, "bad path")
      await rm(await resolveExisting(config.root, rel), { recursive: true })
      sizes.removed(rel)
      const shares = db.query("select id, path from shares").all() as Pick<Share, "id" | "path">[]
      const remove = db.query("delete from shares where id = ?")
      db.transaction(() => {
        for (const share of shares) if (under(share.path, rel)) remove.run(share.id)
      })()
      log("file.delete")
      return json({ ok: true })
    }

    throw new HttpError(404)
  }

  return { handle }
}
