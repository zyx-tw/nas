export type Entry = { name: string; type: "file" | "folder"; size: number; modified: number }

export type Share = {
  id: string
  path: string
  url: string
  createdAt: number
  expiresAt: number | null
  downloads: number
  active: boolean
}

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && typeof init.body === "string") headers.set("content-type", "application/json")
  const res = await fetch(path, { ...init, headers, credentials: "same-origin" })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, body.error ?? String(res.status))
  return body as T
}

export const post = <T>(path: string, body: unknown) => api<T>(path, { method: "POST", body: JSON.stringify(body) })

export function uploadFile(path: string, file: File, overwrite: boolean, onProgress: (fraction: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("PUT", `/api/files/content?path=${encodeURIComponent(path)}${overwrite ? "&overwrite=1" : ""}`)
    xhr.upload.onprogress = event => event.lengthComputable && onProgress(event.loaded / event.total)
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new ApiError(xhr.status, xhr.responseText)))
    xhr.onerror = () => reject(new ApiError(0, "network"))
    xhr.send(file)
  })
}

export const joinPath = (...parts: string[]) => parts.filter(Boolean).join("/")

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

const dateFormat = new Intl.DateTimeFormat("sv-SE", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })

export const formatDate = (ms: number) => dateFormat.format(ms)
