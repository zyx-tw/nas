import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "./app"
import { loadConfig } from "./config"
import { newShareId } from "./shares"

const NAS = "http://nas.test"
const SHARE = "http://s.test"
let dir: string
let app: ReturnType<typeof createApp>
let cookie: string

function req(origin: string, path: string, init: RequestInit & { auth?: boolean } = {}) {
  const headers = new Headers(init.headers)
  headers.set("host", new URL(origin).host)
  if (init.auth !== false && origin === NAS) headers.set("cookie", cookie)
  if (init.method && init.method !== "GET" && init.method !== "HEAD" && !headers.has("origin")) headers.set("origin", NAS)
  return app.fetch(new Request(origin + path, { ...init, headers }), "1.1.1.1")
}

const post = (path: string, body: unknown) => req(NAS, path, { method: "POST", body: JSON.stringify(body) })
const upload = (path: string, body: string, overwrite = false) =>
  req(NAS, `/api/files/content?path=${encodeURIComponent(path)}${overwrite ? "&overwrite=1" : ""}`, { method: "PUT", body })
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = async (res: Response | Promise<Response>): Promise<any> => (await res).json()
const share = async (path: string, days: number | null = 30) => (await body(post("/api/shares", { path, days }))).share

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "nas-test-"))
  mkdirSync(join(dir, "dist/assets"), { recursive: true })
  writeFileSync(join(dir, "dist/index.html"), "<!doctype html><title>NAS</title>")
  writeFileSync(join(dir, "dist/assets/app.js"), "console.log(1)")
  app = createApp(loadConfig({ NAS_DATA: join(dir, "data"), NAS_DIST: join(dir, "dist"), NAS_ORIGIN: NAS, NAS_SHARE_ORIGIN: SHARE, NAS_SETUP_TOKEN: "setup-secret" }))
  const token = "test-session"
  app.db.query("insert into sessions (token_hash, created_at, expires_at) values (?, ?, ?)").run(createHash("sha256").update(token).digest("hex"), Date.now(), Date.now() + 60_000)
  cookie = `nas_session=${token}`
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("hosts and auth", () => {
  test("unknown host is refused", async () => {
    expect((await app.fetch(new Request("http://evil.test/api/files", { headers: { host: "evil.test" } }))).status).toBe(421)
  })
  test("api needs a session", async () => {
    expect((await req(NAS, "/api/files", { auth: false })).status).toBe(401)
  })
  test("writes need the NAS origin", async () => {
    expect((await req(NAS, "/api/files/folder", { method: "POST", body: "{}", headers: { origin: "http://evil.test" } })).status).toBe(403)
  })
  test("the session cookie does not work on the share host", async () => {
    const res = await app.fetch(new Request(SHARE + "/api/files", { headers: { host: "s.test", cookie } }))
    expect(res.status).toBe(404)
  })
  test("setup token gates the first passkey", async () => {
    const me = await body(req(NAS, "/api/auth/me", { auth: false }))
    expect(me).toEqual({ authenticated: false, setup: true })
    const bad = await req(NAS, "/api/auth/register/options", { method: "POST", body: JSON.stringify({ token: "nope" }), auth: false })
    expect(bad.status).toBe(403)
    const good = await req(NAS, "/api/auth/register/options", { method: "POST", body: JSON.stringify({ token: "setup-secret" }), auth: false })
    expect(good.status).toBe(200)
    expect((await body(good)).rp.id).toBe("nas.test")
    expect(good.headers.get("set-cookie")).toContain("nas_flow=")
  })
  test("register verify without a flow fails", async () => {
    const res = await req(NAS, "/api/auth/register/verify", { method: "POST", body: JSON.stringify({ token: "setup-secret", response: {} }), auth: false })
    expect(res.status).toBe(400)
  })
})

describe("files", () => {
  test("upload, list, download", async () => {
    expect((await upload("hello.txt", "hello world")).status).toBe(200)
    expect((await upload("hello.txt", "again")).status).toBe(409)
    expect((await upload("hello.txt", "hello world!", true)).status).toBe(200)
    const list = await body(req(NAS, "/api/files"))
    expect(list.entries.map((e: { name: string }) => e.name)).toContain("hello.txt")
    const res = await req(NAS, "/api/files/content?path=hello.txt")
    expect(await res.text()).toBe("hello world!")
  })
  test("path traversal is rejected", async () => {
    expect((await req(NAS, "/api/files?path=../")).status).toBe(400)
    expect((await upload("../escape.txt", "x")).status).toBe(400)
    expect((await upload("a/../../escape.txt", "x")).status).toBe(400)
  })
  test("symlinks out of the root are hidden and refused", async () => {
    writeFileSync(join(dir, "secret.txt"), "secret")
    symlinkSync(join(dir, "secret.txt"), join(dir, "data/files/link.txt"))
    const list = await body(req(NAS, "/api/files"))
    expect(list.entries.map((e: { name: string }) => e.name)).not.toContain("link.txt")
    expect((await req(NAS, "/api/files/content?path=link.txt")).status).toBe(404)
    expect((await post("/api/shares", { path: "link.txt", days: 1 })).status).toBe(404)
  })
  test("folders, move and delete", async () => {
    expect((await post("/api/files/folder", { path: "docs" })).status).toBe(200)
    expect((await upload("docs/a.txt", "A")).status).toBe(200)
    expect((await upload("missing/a.txt", "A")).status).toBe(404)
    expect((await post("/api/files/move", { from: "docs", to: "docs/inner" })).status).toBe(400)
  })
})

describe("shares", () => {
  test("a file link serves meta, raw and ranges", async () => {
    const s = await share("hello.txt")
    expect(s.id).toMatch(/^[0-9A-Za-z]{22}$/)
    expect(s.url).toBe(`${SHARE}/${s.id}`)
    const meta = await body(req(SHARE, `/api/s/${s.id}`))
    expect(meta).toMatchObject({ name: "hello.txt", type: "file", size: 12 })
    const raw = await req(SHARE, `/${s.id}/raw`)
    expect(await raw.text()).toBe("hello world!")
    expect(raw.headers.get("x-robots-tag")).toContain("noindex")
    expect(raw.headers.get("referrer-policy")).toBe("no-referrer")
    expect(raw.headers.get("content-security-policy")).toContain("sandbox")
    const part = await req(SHARE, `/${s.id}/raw`, { headers: { range: "bytes=6-" } })
    expect(part.status).toBe(206)
    expect(await part.text()).toBe("world!")
    expect((await req(SHARE, `/${s.id}/raw`, { headers: { range: "bytes=99-" } })).status).toBe(416)
    const listed = await body(req(NAS, "/api/shares?path=hello.txt"))
    expect(listed.shares[0].downloads).toBe(1)
  })
  test("html downloads instead of rendering", async () => {
    await upload("page.html", "<script>alert(1)</script>")
    const s = await share("page.html")
    const raw = await req(SHARE, `/${s.id}/raw`)
    expect(raw.headers.get("content-disposition")).toStartWith("attachment")
  })
  test("unicode names survive the download header", async () => {
    await upload("報告.txt", "x")
    const s = await share("報告.txt")
    const raw = await req(SHARE, `/${s.id}/raw?dl=1`)
    expect(raw.headers.get("content-disposition")).toContain(`filename*=UTF-8''${encodeURIComponent("報告.txt")}`)
  })
  test("revoked, expired and unknown links are the same 404", async () => {
    const s = await share("hello.txt")
    expect((await req(NAS, `/api/shares/${s.id}`, { method: "DELETE" })).status).toBe(200)
    const revoked = await req(SHARE, `/api/s/${s.id}`)
    const expiredId = newShareId()
    app.db.query("insert into shares (id, path, created_at, expires_at, downloads) values (?, 'hello.txt', 0, 1, 0)").run(expiredId)
    const expired = await req(SHARE, `/api/s/${expiredId}`)
    const unknown = await req(SHARE, `/api/s/${newShareId()}`)
    for (const res of [revoked, expired, unknown]) {
      expect(res.status).toBe(404)
      expect(await res.text()).toBe('{"error":"404"}')
    }
  })
  test("a folder link lists, serves sub files, zips and refuses escapes", async () => {
    await upload("docs/b.txt", "B")
    const s = await share("docs", null)
    expect(s.expiresAt).toBeNull()
    const meta = await body(req(SHARE, `/api/s/${s.id}`))
    expect(meta.entries.map((e: { name: string }) => e.name)).toEqual(["a.txt", "b.txt"])
    expect(await (await req(SHARE, `/${s.id}/raw?path=b.txt`)).text()).toBe("B")
    expect((await req(SHARE, `/${s.id}/raw?path=../hello.txt`)).status).toBe(400)
    const zip = await req(SHARE, `/${s.id}/zip`)
    expect(zip.status).toBe(200)
    const bytes = new Uint8Array(await zip.arrayBuffer())
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b])
  })
  test("links follow a move and die with a delete", async () => {
    const s = await share("docs/a.txt")
    expect((await post("/api/files/move", { from: "docs", to: "papers" })).status).toBe(200)
    expect(await (await req(SHARE, `/${s.id}/raw`)).text()).toBe("A")
    expect((await req(NAS, "/api/files?path=papers", { method: "DELETE" })).status).toBe(200)
    expect((await req(SHARE, `/${s.id}/raw`)).status).toBe(404)
  })
  test("share page serves the app with noindex", async () => {
    const res = await req(SHARE, `/${newShareId()}`)
    expect(res.status).toBe(200)
    expect(res.headers.get("x-robots-tag")).toContain("noindex")
  })
  test("too many misses from one IP are throttled", async () => {
    let last = 0
    for (let i = 0; i < 25; i++) last = (await req(SHARE, `/api/s/${newShareId()}`)).status
    expect(last).toBe(429)
  })
})
