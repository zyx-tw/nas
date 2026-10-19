import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticatorTransport,
} from "@simplewebauthn/server"
import type { Config } from "./config"
import type { Credential, Db } from "./db"
import { HttpError, json, readJson } from "./http"
import { log } from "./otel"

const SESSION_COOKIE = "nas_session"
const FLOW_COOKIE = "nas_flow"
const SESSION_DAYS = 30
const FLOW_MS = 5 * 60_000
const USER_ID = new TextEncoder().encode("nas-owner")

type Flow = { challenge: string; kind: "register" | "login"; expires: number }

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

function safeEqual(a: string, b: string) {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest())
}

export function cookies(req: Request) {
  const out = new Map<string, string>()
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=")
    if (at > 0) out.set(part.slice(0, at).trim(), part.slice(at + 1).trim())
  }
  return out
}

export function createAuth(config: Config, db: Db) {
  const secure = config.origin.startsWith("https:")
  const rpID = new URL(config.origin).hostname
  const flows = new Map<string, Flow>()

  const cookie = (name: string, value: string, maxAge: number) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`

  function credentialCount() {
    return (db.query("select count(*) as n from credentials").get() as { n: number }).n
  }

  function session(req: Request) {
    const token = cookies(req).get(SESSION_COOKIE)
    if (!token) return false
    const row = db.query("select expires_at from sessions where token_hash = ?").get(sha256(token)) as { expires_at: number } | null
    return !!row && row.expires_at > Date.now()
  }

  function newSession(headers: Headers) {
    const token = randomBytes(32).toString("base64url")
    const now = Date.now()
    db.query("delete from sessions where expires_at < ?").run(now)
    db.query("insert into sessions (token_hash, created_at, expires_at) values (?, ?, ?)").run(sha256(token), now, now + SESSION_DAYS * 86_400_000)
    headers.append("set-cookie", cookie(SESSION_COOKIE, token, SESSION_DAYS * 86_400))
    headers.append("set-cookie", cookie(FLOW_COOKIE, "", 0))
  }

  function startFlow(kind: Flow["kind"], challenge: string, headers: Headers) {
    const now = Date.now()
    for (const [id, flow] of flows) if (flow.expires < now) flows.delete(id)
    const id = randomBytes(24).toString("base64url")
    flows.set(id, { challenge, kind, expires: now + FLOW_MS })
    headers.append("set-cookie", cookie(FLOW_COOKIE, id, FLOW_MS / 1000))
  }

  function takeFlow(req: Request, kind: Flow["kind"]) {
    const id = cookies(req).get(FLOW_COOKIE)
    const flow = id ? flows.get(id) : undefined
    if (id) flows.delete(id)
    if (!flow || flow.kind !== kind || flow.expires < Date.now()) throw new HttpError(400, "expired")
    return flow.challenge
  }

  // Registration needs a session, or the setup token while no passkey exists yet.
  function mayRegister(req: Request, token: unknown) {
    if (session(req)) return true
    return credentialCount() === 0 && !!config.setupToken && typeof token === "string" && safeEqual(token, config.setupToken)
  }

  async function handle(req: Request, path: string): Promise<Response> {
    if (path === "/api/auth/me" && req.method === "GET") {
      return json({ authenticated: session(req), setup: credentialCount() === 0 })
    }
    if (req.method !== "POST") throw new HttpError(405)

    if (path === "/api/auth/logout") {
      const token = cookies(req).get(SESSION_COOKIE)
      if (token) db.query("delete from sessions where token_hash = ?").run(sha256(token))
      return json({ ok: true }, { headers: { "set-cookie": cookie(SESSION_COOKIE, "", 0) } })
    }

    if (path === "/api/auth/register/options") {
      const body = await readJson(req)
      if (!mayRegister(req, body.token)) {
        log("auth.register_denied", {}, "WARN")
        throw new HttpError(403)
      }
      const existing = db.query("select id, transports from credentials").all() as Pick<Credential, "id" | "transports">[]
      const options = await generateRegistrationOptions({
        rpName: "NAS",
        rpID,
        userName: "owner",
        userID: USER_ID,
        attestationType: "none",
        excludeCredentials: existing.map(c => ({ id: c.id, transports: c.transports ? (JSON.parse(c.transports) as AuthenticatorTransport[]) : undefined })),
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
      })
      const headers = new Headers()
      startFlow("register", options.challenge, headers)
      return json(options, { headers })
    }

    if (path === "/api/auth/register/verify") {
      const body = await readJson(req)
      if (!mayRegister(req, body.token)) throw new HttpError(403)
      const expectedChallenge = takeFlow(req, "register")
      let verification
      try {
        verification = await verifyRegistrationResponse({
          response: body.response as never,
          expectedChallenge,
          expectedOrigin: config.origin,
          expectedRPID: rpID,
          requireUserVerification: true,
        })
      } catch {
        verification = { verified: false as const }
      }
      if (!verification.verified || !verification.registrationInfo) {
        log("auth.register_failed", {}, "WARN")
        throw new HttpError(400, "not verified")
      }
      const { credential } = verification.registrationInfo
      db.query("insert into credentials (id, public_key, counter, transports, created_at) values (?, ?, ?, ?, ?)").run(
        credential.id,
        credential.publicKey,
        credential.counter,
        credential.transports ? JSON.stringify(credential.transports) : null,
        Date.now(),
      )
      log("auth.registered", { passkeys: credentialCount() })
      const headers = new Headers()
      newSession(headers)
      return json({ ok: true }, { headers })
    }

    if (path === "/api/auth/login/options") {
      const options = await generateAuthenticationOptions({ rpID, userVerification: "required" })
      const headers = new Headers()
      startFlow("login", options.challenge, headers)
      return json(options, { headers })
    }

    if (path === "/api/auth/login/verify") {
      const body = await readJson(req)
      const expectedChallenge = takeFlow(req, "login")
      const response = body.response as { id?: unknown } | undefined
      const row = typeof response?.id === "string" ? (db.query("select * from credentials where id = ?").get(response.id) as Credential | null) : null
      if (!row) {
        log("auth.login_failed", { reason: "unknown_credential" }, "WARN")
        throw new HttpError(401)
      }
      let verification
      try {
        verification = await verifyAuthenticationResponse({
          response: body.response as never,
          expectedChallenge,
          expectedOrigin: config.origin,
          expectedRPID: rpID,
          requireUserVerification: true,
          credential: {
            id: row.id,
            publicKey: new Uint8Array(row.public_key),
            counter: row.counter,
            transports: row.transports ? (JSON.parse(row.transports) as AuthenticatorTransport[]) : undefined,
          },
        })
      } catch {
        verification = { verified: false as const }
      }
      if (!verification.verified) {
        log("auth.login_failed", { reason: "not_verified" }, "WARN")
        throw new HttpError(401)
      }
      db.query("update credentials set counter = ? where id = ?").run(verification.authenticationInfo.newCounter, row.id)
      log("auth.login")
      const headers = new Headers()
      newSession(headers)
      return json({ ok: true }, { headers })
    }

    throw new HttpError(404)
  }

  return { handle, session }
}
