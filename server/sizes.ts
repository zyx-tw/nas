import { lstat, readdir } from "node:fs/promises"
import { join } from "node:path"
import type { Db } from "./db"
import { log } from "./otel"

const DAY = 24 * 60 * 60 * 1000

const parentOf = (rel: string) => rel.split("/").slice(0, -1).join("/")
const childOf = (rel: string, name: string) => (rel ? `${rel}/${name}` : name)

// Folder sizes, cached per folder in SQLite. A folder's size is its own files plus its
// subfolders' cached sizes, so after a write only the folders on that path are summed again.
// Changes made outside the app are picked up by the daily reconcile.
export function createSizes(root: string, db: Db) {
  db.exec("create table if not exists folder_sizes (path text primary key, size integer not null)")
  const read = db.query("select size from folder_sizes where path = ?")
  const write = db.query("insert or replace into folder_sizes (path, size) values (?, ?)")
  const forget = db.query("delete from folder_sizes where path = ?")
  // Bumped by every write, so a sum that started before the write is never stored.
  let generation = 0

  // rel always comes from a resolved request path or from readdir names below it.
  async function sum(rel: string, sizeOf: (rel: string) => Promise<number>) {
    let total = 0
    for (const dirent of await readdir(join(root, rel), { withFileTypes: true })) {
      if (dirent.isDirectory()) total += await sizeOf(childOf(rel, dirent.name))
      else if (dirent.isFile()) total += (await lstat(join(root, rel, dirent.name)).catch(() => null))?.size ?? 0
    }
    return total
  }

  async function get(rel: string): Promise<number> {
    const cached = read.get(rel) as { size: number } | null
    if (cached) return cached.size
    const started = generation
    const size = await sum(rel, get).catch(() => null)
    if (size === null) return 0
    if (generation === started) write.run(rel, size)
    return size
  }

  // After a write at rel: drop the cache of every folder that contains it.
  function changed(rel: string) {
    generation++
    for (let dir = parentOf(rel); ; dir = parentOf(dir)) {
      forget.run(dir)
      if (!dir) break
    }
  }

  // After a folder is moved away or deleted: drop its cache and its subfolders'.
  function removed(rel: string) {
    changed(rel)
    db.query("delete from folder_sizes where path = ? or substr(path, 1, length(?) + 1) = ? || '/'").run(rel, rel, rel)
  }

  // A full walk that ignores the cache, then replaces it unless a write came in meanwhile.
  async function reconcile() {
    const startedAt = Date.now()
    const started = generation
    const fresh = new Map<string, number>()
    const walk = async (rel: string): Promise<number> => {
      const size = await sum(rel, walk)
      fresh.set(rel, size)
      return size
    }
    await walk("")
    if (generation !== started) return log("sizes.reconcile_skipped")
    db.transaction(() => {
      db.exec("delete from folder_sizes")
      for (const [path, size] of fresh) write.run(path, size)
    })()
    log("sizes.reconcile", { folders: fresh.size, ms: Date.now() - startedAt })
  }

  function start() {
    const run = () => reconcile().catch(error => log("sizes.reconcile_failed", { code: error?.code ?? "unknown" }, "ERROR"))
    void run()
    setInterval(run, DAY).unref()
  }

  return { get, changed, removed, reconcile, start }
}
