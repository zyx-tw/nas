import { createHash, randomBytes } from "node:crypto"
import type { Config } from "./config"
import type { Db } from "./db"
import { type Gate, GateError } from "./gate"
import { HttpError, json } from "./http"
import { log } from "./otel"
import { createLimiter } from "./shares"

const SESSION_DAYS = 30

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

export function cookies(req: Request) {
  const out = new Map<string, string>()
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=")
    if (at > 0) out.set(part.slice(0, at).trim(), part.slice(at + 1).trim())
  }
  return out
}

/** Every value the request carries for one cookie name, in order: `cookies()` keeps only the last. */
function cookieValues(req: Request, name: string) {
  const out: string[] = []
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=")
    if (at > 0 && part.slice(0, at).trim() === name) out.push(part.slice(at + 1).trim())
  }
  return out
}

/**
 * Sessions on nas.zyx.tw. Sign-in happens at auth.zyx.tw: `start` sends the
 * browser there, `callback` takes the signed token back and makes a session
 * bound to the auth session id, so a sign-out there ends this one too.
 */
export function createAuth(config: Config, db: Db, gate: Gate) {
  const secure = config.origin.startsWith("https:")
  // __Host- keeps the cookie to this host: a sibling under the same site cannot set or shadow it.
  // Browsers take the prefix only with Secure, so plain http (local runs) keeps the bare name.
  const SESSION_COOKIE = secure ? "__Host-nas_session" : "nas_session"
  // The name before the prefix. On https the server ignores it, but old browsers still hold it and a rollback would honour it.
  const LEGACY_COOKIE = "nas_session"
  const limiter = createLimiter(60)

  const cookie = (name: string, value: string, maxAge: number) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`

  /** Ends the pre-prefix session on https: drops the row of every value sent and returns the header that clears it, or none on http where it is the live name. */
  function retireLegacy(req: Request) {
    if (!secure) return []
    for (const token of cookieValues(req, LEGACY_COOKIE)) db.query("delete from sessions where token_hash = ?").run(sha256(token))
    return [cookie(LEGACY_COOKIE, "", 0)]
  }

  /** True when the request has a live session here and auth.zyx.tw still holds the one behind it. */
  async function session(req: Request) {
    const token = cookies(req).get(SESSION_COOKIE)
    if (!token || token.length > 128) return false
    const hash = sha256(token)
    const row = db.query("select sid, expires_at from sessions where token_hash = ?").get(hash) as { sid: string; expires_at: number } | null
    if (!row || row.expires_at <= Date.now()) return false
    if (await gate.live(row.sid)) return true
    db.query("delete from sessions where token_hash = ?").run(hash)
    return false
  }

  /** The answer to auth.zyx.tw's form post: a session here, then the app. */
  async function callback(req: Request, ip: string): Promise<Response> {
    if (limiter.blocked(ip)) throw new HttpError(429)
    limiter.miss(ip)
    let grant
    try {
      grant = await gate.callback(req)
    } catch (error) {
      if (error instanceof GateError) {
        log("auth.callback_failed", { reason: error.message }, "WARN")
        throw new HttpError(error.status, error.message)
      }
      throw error
    }
    const now = Date.now()
    const expires = Math.min(now + SESSION_DAYS * 86_400_000, grant.expiresAt)
    const token = randomBytes(32).toString("base64url")
    db.query("delete from sessions where expires_at < ?").run(now)
    db.query("insert into sessions (token_hash, sid, created_at, expires_at) values (?, ?, ?, ?)").run(sha256(token), grant.sid, now, expires)
    log("auth.login")
    const headers = new Headers({ location: "/", "cache-control": "no-store" })
    headers.append("set-cookie", cookie(SESSION_COOKIE, token, Math.floor((expires - now) / 1000)))
    headers.append("set-cookie", gate.clearState)
    for (const legacy of retireLegacy(req)) headers.append("set-cookie", legacy)
    return new Response(null, { status: 303, headers })
  }

  async function handle(req: Request, path: string): Promise<Response> {
    // signOut: where the app finishes a sign-out, so it works even when the logout call fails.
    if (path === "/api/auth/me" && req.method === "GET") return json({ authenticated: await session(req), signOut: `${config.authOrigin}/` })
    if (path === "/api/auth/logout" && req.method === "POST") {
      const token = cookies(req).get(SESSION_COOKIE)
      if (token) db.query("delete from sessions where token_hash = ?").run(sha256(token))
      const headers = new Headers({ "set-cookie": cookie(SESSION_COOKIE, "", 0) })
      for (const legacy of retireLegacy(req)) headers.append("set-cookie", legacy)
      return json({ ok: true }, { headers })
    }
    throw new HttpError(404)
  }

  return { handle, session, callback, start: gate.start }
}
