import { join, resolve } from "node:path"
import type { JWK } from "jose"
import authKey from "./auth-key.json"

export type Config = {
  port: number
  data: string
  root: string
  tmp: string
  dist: string
  origin: string
  shareOrigin: string
  /** Where sign-in happens. */
  authOrigin: string
  /** auth.zyx.tw's public key, pinned in auth-key.json. */
  authKey: JWK
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const data = resolve(env.NAS_DATA ?? "./data")
  const origin = (env.NAS_ORIGIN ?? "http://localhost:8080").replace(/\/$/, "")
  const shareOrigin = (env.NAS_SHARE_ORIGIN ?? "http://127.0.0.1:8080").replace(/\/$/, "")
  if (new URL(origin).host === new URL(shareOrigin).host) throw new Error("NAS_ORIGIN and NAS_SHARE_ORIGIN must use different hosts")
  return {
    port: Number(env.NAS_PORT ?? 8080),
    data,
    root: join(data, "files"),
    tmp: join(data, "tmp"),
    dist: resolve(env.NAS_DIST ?? "./dist"),
    origin,
    shareOrigin,
    authOrigin: env.NAS_AUTH_ORIGIN ?? "https://auth.zyx.tw",
    authKey: authKey as JWK,
  }
}
