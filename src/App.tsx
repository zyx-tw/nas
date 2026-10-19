import { Toaster } from "@/components/ui/sonner"
import { OwnerApp } from "@/owner"

// Only nas.zyx.tw serves this app. s.zyx.tw answers with the shared file itself.
export default function App() {
  return (
    <>
      <OwnerApp />
      <Toaster position="top-center" />
    </>
  )
}
