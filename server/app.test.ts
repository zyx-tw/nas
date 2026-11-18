import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SignJWT, exportJWK, generateKeyPair } from "jose"
import { createApp } from "./app"
import { loadConfig } from "./config"
import { createGate } from "./gate"
import { limitKey, newShareId } from "./shares"

const NAS = "http://nas.test"
const SHARE = "http://s.test"
let dir: string
let app: ReturnType<typeof createApp>
let cookie: string
const AUTH = "https://auth.test"
const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" })
/** Auth session ids that auth.zyx.tw still holds. */
const authLive = new Set<string>(["sid-test"])
const authFetch = (async (input: string) => Response.json({ live: authLive.has(new URL(input).searchParams.get("sid") ?? "") })) as unknown as typeof fetch

function authToken(state: string, audience = NAS) {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ sid: "sid-new", nonce: state, auth_time: now, sexp: now + 86_400 })
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuer(AUTH)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("60s")
    .setJti(crypto.randomUUID())
    .sign(pair.privateKey)
}

const callback = (token: string, state: string, from = AUTH) =>
  req(NAS, "/auth/callback", {
    method: "POST",
    auth: false,
    headers: { origin: from, cookie: `__Host-gate_state=${state}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  })

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

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "nas-test-"))
  mkdirSync(join(dir, "dist/assets"), { recursive: true })
  writeFileSync(join(dir, "dist/index.html"), "<!doctype html><title>NAS</title>")
  writeFileSync(join(dir, "dist/assets/app.js"), "console.log(1)")
  const config = loadConfig({ NAS_DATA: join(dir, "data"), NAS_DIST: join(dir, "dist"), NAS_ORIGIN: NAS, NAS_SHARE_ORIGIN: SHARE, NAS_AUTH_ORIGIN: AUTH })
  const gate = createGate({ authOrigin: AUTH, app: "nas", origin: NAS, publicKey: await exportJWK(pair.publicKey), liveCacheMs: 0 }, authFetch)
  app = createApp(config, gate)
  const token = "test-session"
  app.db.query("insert into sessions (token_hash, sid, created_at, expires_at) values (?, ?, ?, ?)").run(createHash("sha256").update(token).digest("hex"), "sid-test", Date.now(), Date.now() + 60_000)
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
  test("a valid token from auth.zyx.tw makes a session", async () => {
    const state = "s".repeat(32)
    authLive.add("sid-new")
    const res = await callback(await authToken(state), state)
    expect(res.status).toBe(303)
    const set = res.headers.getSetCookie().find(c => c.startsWith("nas_session="))!
    const token = set.split(";")[0].split("=")[1]
    const me = await app.fetch(new Request(NAS + "/api/auth/me", { headers: { host: "nas.test", cookie: `nas_session=${token}` } }))
    expect(await me.json()).toEqual({ authenticated: true, signOut: `${AUTH}/` })
    // Signing out at auth.zyx.tw ends it here.
    authLive.delete("sid-new")
    const after = await app.fetch(new Request(NAS + "/api/auth/me", { headers: { host: "nas.test", cookie: `nas_session=${token}` } }))
    expect(await after.json()).toEqual({ authenticated: false, signOut: `${AUTH}/` })
  })
  test("the callback refuses a wrong state, origin, audience or a replay", async () => {
    const state = "t".repeat(32)
    authLive.add("sid-new")
    expect((await callback(await authToken(state), "u".repeat(32))).status).toBe(403)
    expect((await callback(await authToken(state), state, "http://evil.test")).status).toBe(403)
    expect((await callback(await authToken(state, "https://ssh.zyx.tw"), state)).status).toBe(403)
    const token = await authToken(state)
    expect((await callback(token, state)).status).toBe(303)
    expect((await callback(token, state)).status).toBe(403)
  })
  test("start sends the browser to auth.zyx.tw", async () => {
    const res = await req(NAS, "/auth/start", { auth: false })
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toStartWith(`${AUTH}/authorize?app=nas&state=`)
  })
  test("an oversized json body is refused before it fills memory", async () => {
    const big = "x".repeat(65 * 1024)
    const declared = await req(NAS, "/api/files/folder", { method: "POST", body: big })
    expect(declared.status).toBe(413)
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 20; i++) controller.enqueue(new TextEncoder().encode("x".repeat(8192)))
        controller.close()
      },
    })
    const chunked = await req(NAS, "/api/files/folder", { method: "POST", body: stream })
    expect(chunked.status).toBe(413)
  })
})

describe("session cookie on https", () => {
  // A sibling host under the same site (any *.zyx.tw) can set a cookie for the parent domain.
  // Only a __Host- cookie is safe from that: the browser keeps it to this host, Secure and Path=/.
  const HTTPS = "https://nas.secure.test"
  let secureApp: ReturnType<typeof createApp>
  beforeAll(async () => {
    const config = loadConfig({ NAS_DATA: join(dir, "data-https"), NAS_DIST: join(dir, "dist"), NAS_ORIGIN: HTTPS, NAS_SHARE_ORIGIN: "https://s.secure.test", NAS_AUTH_ORIGIN: AUTH })
    const gate = createGate({ authOrigin: AUTH, app: "nas", origin: HTTPS, publicKey: await exportJWK(pair.publicKey), liveCacheMs: 0 }, authFetch)
    secureApp = createApp(config, gate)
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const me = async (cookie: string): Promise<any> =>
    (await secureApp.fetch(new Request(HTTPS + "/api/auth/me", { headers: { host: "nas.secure.test", cookie } }), "1.1.1.1")).json()

  test("the session cookie has the __Host- prefix and a planted plain one is ignored", async () => {
    const state = "h".repeat(32)
    authLive.add("sid-new")
    const res = await secureApp.fetch(
      new Request(HTTPS + "/auth/callback", {
        method: "POST",
        headers: { host: "nas.secure.test", origin: AUTH, cookie: `__Host-gate_state=${state}`, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: await authToken(state, HTTPS) }).toString(),
      }),
      "1.1.1.1",
    )
    expect(res.status).toBe(303)
    const set = res.headers.getSetCookie().find(c => c.includes("nas_session="))!
    expect(set).toStartWith("__Host-nas_session=")
    expect(set).toContain("; Secure")
    expect(set).toContain("; Path=/;")
    expect(set.toLowerCase()).not.toContain("domain=")
    const token = set.split(";")[0].split("=")[1]
    expect((await me(`__Host-nas_session=${token}`)).authenticated).toBe(true)
    expect((await me(`nas_session=${token}`)).authenticated).toBe(false)
  })
  test("sign-out clears the cookie, and the app learns the auth origin to finish at", async () => {
    expect((await me("")).signOut).toBe(`${AUTH}/`)
    const token = "live-secure-session"
    const legacy = "legacy-session"
    for (const t of [token, legacy])
      secureApp.db.query("insert into sessions (token_hash, sid, created_at, expires_at) values (?, ?, ?, ?)").run(createHash("sha256").update(t).digest("hex"), "sid-test", Date.now(), Date.now() + 60_000)
    authLive.add("sid-test")
    expect((await me(`__Host-nas_session=${token}`)).authenticated).toBe(true)
    const res = await secureApp.fetch(
      new Request(HTTPS + "/api/auth/logout", { method: "POST", headers: { host: "nas.secure.test", origin: HTTPS, cookie: `__Host-nas_session=${token}; nas_session=${legacy}` } }),
      "1.1.1.1",
    )
    const set = res.headers.getSetCookie()
    const host = set.find(c => c.startsWith("__Host-nas_session=;"))!
    for (const part of ["Max-Age=0", "Secure", "Path=/;"]) expect(host).toContain(part)
    const old = set.find(c => c.startsWith("nas_session=;"))!
    for (const part of ["Max-Age=0", "Secure", "Path=/;"]) expect(old).toContain(part)
    expect((await me(`__Host-nas_session=${token}`)).authenticated).toBe(false)
    // A rollback to the old name must not bring the legacy session back.
    expect(secureApp.db.query("select count(*) as n from sessions where token_hash = ?").get(createHash("sha256").update(legacy).digest("hex"))).toEqual({ n: 0 })
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
    expect((await post("/api/files/folder", { path: "docs/inner" })).status).toBe(200)
    expect((await upload("docs/inner/b.txt", "BB")).status).toBe(200)
    const list = await body(req(NAS, "/api/files"))
    expect(list.entries.find((e: { name: string }) => e.name === "docs").size).toBe(3)
    expect((await upload("docs/inner/c.txt", "CCCC")).status).toBe(200)
    const after = await body(req(NAS, "/api/files"))
    expect(after.entries.find((e: { name: string }) => e.name === "docs").size).toBe(7)
  })
})

describe("shares", () => {
  test("a file link answers with the file itself, with ranges", async () => {
    const s = await share("hello.txt")
    expect(s.id).toMatch(/^[0-9A-Za-z]{22}$/)
    expect(s.url).toBe(`${SHARE}/${s.id}`)
    const raw = await req(SHARE, `/${s.id}`)
    expect(raw.headers.get("content-type")).toStartWith("text/plain")
    expect(raw.headers.get("content-disposition")).toStartWith("inline")
    expect(await raw.text()).toBe("hello world!")
    expect(raw.headers.get("x-robots-tag")).toContain("noindex")
    expect(raw.headers.get("referrer-policy")).toBe("no-referrer")
    expect(raw.headers.get("x-content-type-options")).toBe("nosniff")
    const part = await req(SHARE, `/${s.id}`, { headers: { range: "bytes=6-" } })
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
    const revoked = await req(SHARE, `/${s.id}`)
    const expiredId = newShareId()
    app.db.query("insert into shares (id, path, created_at, expires_at, downloads) values (?, 'hello.txt', 0, 1, 0)").run(expiredId)
    const expired = await req(SHARE, `/${expiredId}`)
    const unknown = await req(SHARE, `/${newShareId()}`)
    const bodies = new Set<string>()
    for (const res of [revoked, expired, unknown]) {
      expect(res.status).toBe(404)
      bodies.add(await res.text())
    }
    expect(bodies.size).toBe(1)
    expect([...bodies][0]).toContain("Invalid link")
  })
  test("a folder link lists, serves sub files, zips and refuses escapes", async () => {
    await upload("docs/b.txt", "B")
    const s = await share("docs", null)
    expect(s.expiresAt).toBeNull()
    const page = await req(SHARE, `/${s.id}`)
    expect(page.headers.get("content-type")).toStartWith("text/html")
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'")
    const html = await page.text()
    expect(html).toContain('href="?path=a.txt">a.txt</a>')
    expect(html).toContain('href="?path=b.txt">b.txt</a>')
    expect(html).not.toContain("<script")
    expect(await (await req(SHARE, `/${s.id}?path=b.txt`)).text()).toBe("B")
    expect((await req(SHARE, `/${s.id}?path=../hello.txt`)).status).toBe(400)
    const zip = await req(SHARE, `/${s.id}/zip`)
    expect(zip.status).toBe(200)
    const bytes = new Uint8Array(await zip.arrayBuffer())
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b])
  })
  test("links follow a move and die with a delete", async () => {
    const s = await share("docs/a.txt")
    expect((await post("/api/files/move", { from: "docs", to: "papers" })).status).toBe(200)
    expect(await (await req(SHARE, `/${s.id}`)).text()).toBe("A")
    expect((await req(NAS, "/api/files?path=papers", { method: "DELETE" })).status).toBe(200)
    expect((await req(SHARE, `/${s.id}`)).status).toBe(404)
  })
  test("folder names are escaped in the list", async () => {
    await post("/api/files/folder", { path: "esc" })
    await upload('esc/<img src=x onerror=alert(1)>.txt', "x")
    const html = await (await req(SHARE, `/${(await share("esc")).id}`)).text()
    expect(html).not.toContain("<img")
    expect(html).toContain("&#60;img")
  })
  test("the share host serves no app and no api", async () => {
    for (const path of ["/assets/app.js", "/api/files", "/favicon.ico"]) {
      const res = await req(SHARE, path)
      expect(res.status).toBe(404)
      expect(res.headers.get("x-robots-tag")).toContain("noindex")
    }
  })
  test("a video link is a full window player around the raw file", async () => {
    writeFileSync(join(dir, "data/files/clip.mp4"), "fake")
    const s = await share("clip.mp4")
    const page = await req(SHARE, `/${s.id}`)
    expect(page.headers.get("content-type")).toStartWith("text/html")
    const html = await page.text()
    expect(html).toContain(`<video src="/${s.id}/raw" controls`)
    expect(html).toContain("object-fit:contain")
    const raw = await req(SHARE, `/${s.id}/raw`, { headers: { range: "bytes=0-1" } })
    expect(raw.status).toBe(206)
    expect(raw.headers.get("content-type")).toBe("video/mp4")
    expect(raw.headers.get("content-security-policy")).toBeNull()
    const listed = await body(req(NAS, "/api/shares?path=clip.mp4"))
    expect(listed.shares[0].downloads).toBe(1)
  })
  test("pdf previews without the sandbox, html keeps it", async () => {
    await upload("a.pdf", "%PDF-1.4")
    const pdf = await req(SHARE, `/${(await share("a.pdf")).id}/raw`)
    expect(pdf.headers.get("content-disposition")).toStartWith("inline")
    expect(pdf.headers.get("content-security-policy")).toBeNull()
    const html = await req(SHARE, `/${(await share("page.html")).id}/raw`)
    expect(html.headers.get("content-security-policy")).toContain("sandbox")
  })
  test("limiter keys group IPv6 by /64", () => {
    expect(limitKey("1.2.3.4")).toBe("1.2.3.4")
    expect(limitKey("::ffff:1.2.3.4")).toBe("1.2.3.4")
    expect(limitKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64")
    expect(limitKey("2001:db8:1:2:bbbb:cccc:dddd:eeee")).toBe("2001:db8:1:2::/64")
    expect(limitKey("2001:db8::1")).toBe("2001:db8:0:0::/64")
  })
  test("the share host root redirects to www.zyx.tw", async () => {
    const res = await req(SHARE, "/")
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://www.zyx.tw/")
  })
  test("too many misses from one IP are throttled", async () => {
    let last = 0
    for (let i = 0; i < 25; i++) last = (await req(SHARE, `/${newShareId()}`)).status
    expect(last).toBe(429)
  })
})
