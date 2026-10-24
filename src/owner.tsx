import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import { startAuthentication, startRegistration } from "@simplewebauthn/browser"
import { Copy, File, Folder, FolderPlus, LogOut, MoreHorizontal, Upload, X } from "lucide-react"
import { toast } from "sonner"
import { TaskShell } from "@/components/task-shell"
import { TaskThemeToggle } from "@/components/task-theme"
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ApiError, api, formatDate, formatSize, joinPath, post, uploadFile, type Entry, type Share } from "@/lib/api"

type Me = { authenticated: boolean; setup: boolean }

function failMessage(error: unknown) {
  if (error instanceof ApiError && error.status === 409) return "已有同名項目"
  if (error instanceof ApiError && error.status === 401) return "請重新登入"
  return "操作失敗"
}

function readPath() {
  return new URLSearchParams(window.location.search).get("path") ?? ""
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success("已複製連結")
  } catch {
    toast.error("無法複製")
  }
}

function expiry(share: Share) {
  return share.expiresAt === null ? "永久" : formatDate(share.expiresAt)
}

export function OwnerApp() {
  const [me, setMe] = useState<Me | null>(null)
  const setupToken = new URLSearchParams(window.location.search).get("setup")

  useEffect(() => {
    api<Me>("/api/auth/me").then(setMe, () => setMe({ authenticated: false, setup: false }))
  }, [])

  async function login() {
    try {
      const optionsJSON = await post<Parameters<typeof startAuthentication>[0]["optionsJSON"]>("/api/auth/login/options", {})
      const response = await startAuthentication({ optionsJSON })
      await post("/api/auth/login/verify", { response })
      setMe({ authenticated: true, setup: false })
    } catch {
      toast.error("登入失敗")
    }
  }

  async function register() {
    try {
      const optionsJSON = await post<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/api/auth/register/options", { token: setupToken })
      const response = await startRegistration({ optionsJSON })
      await post("/api/auth/register/verify", { token: setupToken, response })
      window.history.replaceState(null, "", "/")
      setMe({ authenticated: true, setup: false })
    } catch {
      toast.error("註冊失敗")
    }
  }

  async function logout() {
    await post("/api/auth/logout", {}).catch(() => {})
    setMe({ authenticated: false, setup: false })
  }

  const actions = (
    <>
      <TaskThemeToggle lang="zh-TW" />
      {me?.authenticated && (
        <Button type="button" variant="ghost" size="icon" className="-m-3" onClick={logout} aria-label="登出" title="登出">
          <LogOut aria-hidden />
        </Button>
      )}
    </>
  )

  return (
    <TaskShell title="NAS" lang="zh-TW" actions={actions} wide>
      {me && !me.authenticated && (
        <section aria-label="登入" className="flex gap-3">
          {me.setup && setupToken ? <Button onClick={register}>註冊</Button> : <Button onClick={login}>登入</Button>}
        </section>
      )}
      {me?.authenticated && <Workspace onSignedOut={() => setMe({ authenticated: false, setup: false })} />}
    </TaskShell>
  )
}

function Workspace({ onSignedOut }: { onSignedOut: () => void }) {
  const [tab, setTab] = useState<"files" | "links">("files")
  return (
    <Tabs value={tab} onValueChange={value => setTab(value as "files" | "links")}>
      <TabsList className="mb-6">
        <TabsTrigger value="files">檔案</TabsTrigger>
        <TabsTrigger value="links">連結</TabsTrigger>
      </TabsList>
      {tab === "files" ? <Files onSignedOut={onSignedOut} /> : <Links onSignedOut={onSignedOut} />}
    </Tabs>
  )
}

type Upload_ = { key: number; name: string; progress: number }

function Files({ onSignedOut }: { onSignedOut: () => void }) {
  const [path, setPath] = useState(readPath)
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [uploads, setUploads] = useState<Upload_[]>([])
  const [dragging, setDragging] = useState(false)
  const [naming, setNaming] = useState<{ mode: "folder" } | { mode: "rename"; entry: Entry } | null>(null)
  const [sharing, setSharing] = useState<Entry | null>(null)
  const [deleting, setDeleting] = useState<Entry | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const nextKey = useRef(0)

  const fail = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.status === 401) onSignedOut()
    toast.error(failMessage(error))
  }, [onSignedOut])

  const reload = useCallback(() => {
    api<{ entries: Entry[] }>(`/api/files?path=${encodeURIComponent(path)}`).then(result => setEntries(result.entries), fail)
  }, [path, fail])

  useEffect(reload, [reload])

  useEffect(() => {
    const onPop = () => setPath(readPath())
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])

  function open(next: string) {
    window.history.pushState(null, "", next ? `?path=${encodeURIComponent(next)}` : "/")
    setPath(next)
  }

  async function sendOne(file: File, overwrite = false) {
    const key = nextKey.current++
    setUploads(list => [...list, { key, name: file.name, progress: 0 }])
    try {
      await uploadFile(joinPath(path, file.name), file, overwrite, progress => setUploads(list => list.map(u => (u.key === key ? { ...u, progress } : u))))
      reload()
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        toast.error(`已有 ${file.name}`, { action: { label: "覆蓋", onClick: () => void sendOne(file, true) } })
      } else fail(error)
    } finally {
      setUploads(list => list.filter(u => u.key !== key))
    }
  }

  async function send(files: FileList | null) {
    for (const file of Array.from(files ?? [])) await sendOne(file)
  }

  async function submitName(name: string) {
    if (!name || name.includes("/")) {
      toast.error("名稱無效")
      return false
    }
    try {
      if (naming?.mode === "folder") await post("/api/files/folder", { path: joinPath(path, name) })
      else if (naming?.mode === "rename") await post("/api/files/move", { from: joinPath(path, naming.entry.name), to: joinPath(path, name) })
      reload()
      return true
    } catch (error) {
      fail(error)
      return false
    }
  }

  async function remove(entry: Entry) {
    try {
      await api(`/api/files?path=${encodeURIComponent(joinPath(path, entry.name))}`, { method: "DELETE" })
      reload()
    } catch (error) {
      fail(error)
      throw error
    }
  }

  const contentUrl = (entry: Entry, download = false) => `/api/files/content?path=${encodeURIComponent(joinPath(path, entry.name))}${download ? "&dl=1" : ""}`
  const crumbs = path ? path.split("/") : []

  return (
    <section
      aria-label="檔案"
      className={dragging ? "rounded-surface bg-muted/50" : undefined}
      onDragOver={event => {
        if (!event.dataTransfer.types.includes("Files")) return
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false)
      }}
      onDrop={event => {
        event.preventDefault()
        setDragging(false)
        void send(event.dataTransfer.files)
      }}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="路徑" className="flex min-w-0 flex-wrap items-center gap-1 text-body text-muted-foreground">
          <button type="button" className="hover:text-foreground" onClick={() => open("")}>檔案</button>
          {crumbs.map((part, index) => (
            <span key={index} className="flex items-center gap-1">
              <span aria-hidden>/</span>
              <button type="button" className="hover:text-foreground" onClick={() => open(crumbs.slice(0, index + 1).join("/"))}>{part}</button>
            </span>
          ))}
        </nav>
        <div className="flex gap-3">
          <Button variant="outline" onClick={() => setNaming({ mode: "folder" })}>
            <FolderPlus aria-hidden />
            新資料夾
          </Button>
          <Button onClick={() => input.current?.click()}>
            <Upload aria-hidden />
            上傳
          </Button>
          <input
            ref={input}
            type="file"
            multiple
            hidden
            onChange={event => {
              void send(event.target.files)
              event.target.value = ""
            }}
          />
        </div>
      </div>

      {uploads.length > 0 && (
        <ul aria-label="上傳中" className="mb-4 flex flex-col gap-2">
          {uploads.map(u => (
            <li key={u.key} className="flex items-center justify-between gap-4 text-caption text-muted-foreground">
              <span className="truncate">{u.name}</span>
              <span className="tabular-nums">{Math.round(u.progress * 100)}%</span>
            </li>
          ))}
        </ul>
      )}

      {entries && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名稱</TableHead>
              <TableHead className="hidden text-right sm:table-cell">大小</TableHead>
              <TableHead className="hidden text-right md:table-cell">修改時間</TableHead>
              <TableHead className="w-10"><span className="sr-only">操作</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={4} className="py-10 text-center text-muted-foreground">空資料夾</TableCell>
              </TableRow>
            )}
            {entries.map(entry => (
              <TableRow key={entry.name}>
                <TableCell className="max-w-0 w-full">
                  {entry.type === "folder" ? (
                    <button type="button" className="flex w-full items-center gap-3 text-left" onClick={() => open(joinPath(path, entry.name))}>
                      <Folder aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{entry.name}</span>
                    </button>
                  ) : (
                    <a className="flex items-center gap-3" href={contentUrl(entry)} target="_blank" rel="noreferrer">
                      <File aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{entry.name}</span>
                    </a>
                  )}
                </TableCell>
                <TableCell className="hidden text-right whitespace-nowrap text-muted-foreground tabular-nums sm:table-cell">{formatSize(entry.size)}</TableCell>
                <TableCell className="hidden text-right whitespace-nowrap text-muted-foreground tabular-nums md:table-cell">{formatDate(entry.modified)}</TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={`${entry.name} 的操作`} />}>
                      <MoreHorizontal aria-hidden />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {entry.type === "file" && <DropdownMenuItem render={<a href={contentUrl(entry, true)} />}>下載</DropdownMenuItem>}
                      <DropdownMenuItem onClick={() => setSharing(entry)}>分享</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setNaming({ mode: "rename", entry })}>重新命名</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setDeleting(entry)}>刪除</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <NameDialog
        key={naming ? (naming.mode === "rename" ? `rename:${naming.entry.name}` : "folder") : "closed"}
        open={naming !== null}
        title={naming?.mode === "rename" ? "重新命名" : "新資料夾"}
        initial={naming?.mode === "rename" ? naming.entry.name : ""}
        confirm={naming?.mode === "rename" ? "儲存" : "建立"}
        onClose={() => setNaming(null)}
        onSubmit={submitName}
      />
      <ShareDialog key={sharing?.name ?? "none"} path={sharing ? joinPath(path, sharing.name) : null} name={sharing?.name ?? ""} onClose={() => setSharing(null)} onError={fail} />
      <ConfirmDialog
        open={deleting !== null}
        title={`刪除「${deleting?.name ?? ""}」？`}
        confirm="刪除"
        onClose={() => setDeleting(null)}
        onConfirm={() => (deleting ? remove(deleting) : Promise.resolve())}
      />
    </section>
  )
}

function NameDialog({ open, title, initial, confirm, onClose, onSubmit }: {
  open: boolean
  title: string
  initial: string
  confirm: string
  onClose: () => void
  onSubmit: (name: string) => Promise<boolean>
}) {
  const [name, setName] = useState(initial)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    const ok = await onSubmit(name.trim())
    setBusy(false)
    if (ok) onClose()
  }

  return (
    <Dialog open={open} onOpenChange={next => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <Label htmlFor="name">名稱</Label>
            <Input id="name" value={name} onChange={event => setName(event.target.value)} autoFocus autoComplete="off" />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={busy || !name.trim()}>{confirm}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const DAYS = [
  { value: "1", label: "1 天" },
  { value: "7", label: "7 天" },
  { value: "30", label: "30 天" },
  { value: "0", label: "永久" },
]

function ShareDialog({ path, name, onClose, onError }: { path: string | null; name: string; onClose: () => void; onError: (error: unknown) => void }) {
  const [days, setDays] = useState("30")
  const [shares, setShares] = useState<Share[]>([])
  const [busy, setBusy] = useState(false)
  const [revoking, setRevoking] = useState<Share | null>(null)

  const load = useCallback(() => {
    if (path === null) return
    api<{ shares: Share[] }>(`/api/shares?path=${encodeURIComponent(path)}`).then(result => setShares(result.shares.filter(s => s.active)), onError)
  }, [path, onError])

  useEffect(load, [load])

  async function create() {
    if (path === null) return
    setBusy(true)
    try {
      const { share } = await post<{ share: Share }>("/api/shares", { path, days: days === "0" ? null : Number(days) })
      load()
      await copy(share.url)
    } catch (error) {
      onError(error)
    } finally {
      setBusy(false)
    }
  }

  async function revoke(share: Share) {
    try {
      await api(`/api/shares/${share.id}`, { method: "DELETE" })
      load()
    } catch (error) {
      onError(error)
      throw error
    }
  }

  return (
    <Dialog open={path !== null} onOpenChange={next => !next && onClose()}>
      <DialogContent size="wide">
        <DialogHeader>
          <DialogTitle className="truncate">分享「{name}」</DialogTitle>
        </DialogHeader>
        {shares.length > 0 && (
          <ul aria-label="有效連結" className="flex flex-col gap-3">
            {shares.map(share => (
              <li key={share.id} className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-caption">{share.url}</p>
                  <p className="text-caption text-muted-foreground">{share.expiresAt === null ? "永久有效" : `到期 ${expiry(share)}`}，下載 {share.downloads} 次</p>
                </div>
                <Button variant="ghost" size="icon" aria-label="複製" title="複製" onClick={() => void copy(share.url)}>
                  <Copy aria-hidden />
                </Button>
                <Button variant="ghost" size="icon" aria-label="撤銷" title="撤銷" onClick={() => setRevoking(share)}>
                  <X aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-col gap-2">
          <Label htmlFor="days">期限</Label>
          <div className="flex gap-3">
            <Select items={DAYS} value={days} onValueChange={value => value && setDays(value)}>
              <SelectTrigger id="days" className="flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DAYS.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button onClick={create} disabled={busy}>建立連結</Button>
          </div>
        </div>
        <ConfirmDialog open={revoking !== null} title="撤銷這個連結？" confirm="撤銷" onClose={() => setRevoking(null)} onConfirm={() => (revoking ? revoke(revoking) : Promise.resolve())} />
      </DialogContent>
    </Dialog>
  )
}

function Links({ onSignedOut }: { onSignedOut: () => void }) {
  const [shares, setShares] = useState<Share[] | null>(null)
  const [revoking, setRevoking] = useState<Share | null>(null)

  const fail = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.status === 401) onSignedOut()
    toast.error(failMessage(error))
  }, [onSignedOut])

  const load = useCallback(() => {
    api<{ shares: Share[] }>("/api/shares").then(result => setShares(result.shares), fail)
  }, [fail])

  useEffect(load, [load])

  async function revoke(share: Share) {
    try {
      await api(`/api/shares/${share.id}`, { method: "DELETE" })
      load()
    } catch (error) {
      fail(error)
      throw error
    }
  }

  if (!shares) return null

  return (
    <section aria-label="連結">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>檔案</TableHead>
            <TableHead className="hidden text-right sm:table-cell">到期</TableHead>
            <TableHead className="hidden text-right md:table-cell">下載</TableHead>
            <TableHead className="w-24"><span className="sr-only">操作</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shares.length === 0 && (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={4} className="py-10 text-center text-muted-foreground">沒有連結</TableCell>
            </TableRow>
          )}
          {shares.map(share => (
            <TableRow key={share.id} className={share.active ? undefined : "text-muted-foreground"}>
              <TableCell className="max-w-0 w-full">
                <span className="block truncate">{share.path}</span>
              </TableCell>
              <TableCell className="hidden text-right whitespace-nowrap tabular-nums sm:table-cell">{share.active ? expiry(share) : "已過期"}</TableCell>
              <TableCell className="hidden text-right tabular-nums md:table-cell">{share.downloads}</TableCell>
              <TableCell>
                <div className="flex justify-end gap-1">
                  <Button variant="ghost" size="icon" aria-label="複製" title="複製" disabled={!share.active} onClick={() => void copy(share.url)}>
                    <Copy aria-hidden />
                  </Button>
                  <Button variant="ghost" size="icon" aria-label="撤銷" title="撤銷" onClick={() => setRevoking(share)}>
                    <X aria-hidden />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ConfirmDialog open={revoking !== null} title="撤銷這個連結？" confirm="撤銷" onClose={() => setRevoking(null)} onConfirm={() => (revoking ? revoke(revoking) : Promise.resolve())} />
    </section>
  )
}

function ConfirmDialog({ open, title, confirm, onClose, onConfirm }: {
  open: boolean
  title: string
  confirm: string
  onClose: () => void
  onConfirm: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)

  async function run() {
    setBusy(true)
    try {
      await onConfirm()
      onClose()
    } catch {
      // The caller already showed a toast; stay open for a retry.
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={next => !next && !busy && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-all">{title}</AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
          <Button variant="destructive" disabled={busy} onClick={run}>{confirm}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
