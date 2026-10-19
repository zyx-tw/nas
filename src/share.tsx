import { useEffect, useState } from "react"
import { Download, File, Folder } from "lucide-react"
import { TaskShell } from "@/components/task-shell"
import { TaskThemeToggle } from "@/components/task-theme"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { api, formatDate, formatSize, joinPath, type SharedItem } from "@/lib/api"

function readSub() {
  return new URLSearchParams(window.location.search).get("path") ?? ""
}

function rawUrl(id: string, sub: string, download = false) {
  const params = new URLSearchParams()
  if (sub) params.set("path", sub)
  if (download) params.set("dl", "1")
  const query = params.toString()
  return `/${id}/raw${query ? `?${query}` : ""}`
}

function Preview({ id, item }: { id: string; item: SharedItem }) {
  const mime = item.mime ?? ""
  const src = rawUrl(id, item.path)
  if (mime.startsWith("image/") && mime !== "image/svg+xml") return <img src={src} alt={item.name} className="max-h-[70svh] w-full rounded-control object-contain" />
  if (mime.startsWith("video/")) return <video src={src} controls playsInline className="max-h-[70svh] w-full rounded-control" />
  if (mime.startsWith("audio/")) return <audio src={src} controls className="w-full" />
  return null
}

export function SharePage({ id }: { id: string | null }) {
  const [sub, setSub] = useState(readSub)
  const [item, setItem] = useState<SharedItem | "invalid" | null>(id ? null : "invalid")

  useEffect(() => {
    const onPop = () => setSub(readSub())
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])

  useEffect(() => {
    if (!id) return
    let live = true
    api<SharedItem>(`/api/s/${id}${sub ? `?path=${encodeURIComponent(sub)}` : ""}`)
      .then(result => live && setItem(result))
      .catch(() => live && setItem("invalid"))
    return () => {
      live = false
    }
  }, [id, sub])

  function open(next: string) {
    const url = next ? `?path=${encodeURIComponent(next)}` : window.location.pathname
    window.history.pushState(null, "", url)
    setSub(next)
  }

  const title = item === "invalid" ? "連結無效" : item?.root ?? ""
  const crumbs = item && item !== "invalid" && item.path ? item.path.split("/") : []

  return (
    <TaskShell title={title} lang="zh-TW" actions={<TaskThemeToggle lang="zh-TW" />}>
      {id && item && item !== "invalid" && (
        <section aria-label="分享內容" className="flex flex-col gap-6">
          {crumbs.length > 0 && (
            <nav aria-label="路徑" className="flex flex-wrap items-center gap-1 text-body text-muted-foreground">
              <button type="button" className="hover:text-foreground" onClick={() => open("")}>{item.root}</button>
              {crumbs.map((part, index) => (
                <span key={index} className="flex items-center gap-1">
                  <span aria-hidden>/</span>
                  <button type="button" className="hover:text-foreground" onClick={() => open(crumbs.slice(0, index + 1).join("/"))}>{part}</button>
                </span>
              ))}
            </nav>
          )}

          {item.type === "file" ? (
            <>
              <Preview id={id} item={item} />
              <div className="flex flex-wrap items-center justify-between gap-4">
                <p className="text-caption text-muted-foreground">{formatSize(item.size)}</p>
                <Button render={<a href={rawUrl(id, item.path, true)} />}>
                  <Download aria-hidden />
                  下載
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="flex justify-end">
                <Button render={<a href={`/${id}/zip${item.path ? `?path=${encodeURIComponent(item.path)}` : ""}`} />}>
                  <Download aria-hidden />
                  全部下載
                </Button>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名稱</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">大小</TableHead>
                    <TableHead className="hidden text-right md:table-cell">修改時間</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {item.entries?.map(entry => (
                    <TableRow key={entry.name}>
                      <TableCell className="max-w-0 w-full">
                        {entry.type === "folder" ? (
                          <button type="button" className="flex w-full items-center gap-3 text-left" onClick={() => open(joinPath(item.path, entry.name))}>
                            <Folder aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                            <span className="truncate">{entry.name}</span>
                          </button>
                        ) : (
                          <a className="flex items-center gap-3" href={rawUrl(id, joinPath(item.path, entry.name))} target="_blank" rel="noreferrer">
                            <File aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                            <span className="truncate">{entry.name}</span>
                          </a>
                        )}
                      </TableCell>
                      <TableCell className="hidden text-right whitespace-nowrap text-muted-foreground tabular-nums sm:table-cell">{entry.type === "file" ? formatSize(entry.size) : ""}</TableCell>
                      <TableCell className="hidden text-right whitespace-nowrap text-muted-foreground tabular-nums md:table-cell">{formatDate(entry.modified)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </section>
      )}
    </TaskShell>
  )
}
