import { Toaster } from "@/components/ui/sonner"
import { OwnerApp } from "@/owner"
import { SharePage } from "@/share"

// nas.zyx.tw serves the owner app at "/"; s.zyx.tw serves one share per "/<id>".
const shareId = /^\/([0-9A-Za-z]{22})\/?$/.exec(window.location.pathname)?.[1] ?? null
const isShare = window.location.pathname !== "/"

export default function App() {
  return (
    <>
      {isShare ? <SharePage id={shareId} /> : <OwnerApp />}
      <Toaster position="top-center" />
    </>
  )
}
