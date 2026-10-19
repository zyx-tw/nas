#!/usr/bin/env node
// End to end in Chromium with a virtual passkey: register, upload, share,
// open the share on the other host, download, revoke.
// Usage: node scripts/e2e.mjs <nas-origin> <share-origin> <setup-token>
import { chromium } from "playwright"

const [nas, shareOrigin, token] = process.argv.slice(2)
if (!nas || !shareOrigin || !token) {
  console.error("usage: node scripts/e2e.mjs <nas-origin> <share-origin> <setup-token>")
  process.exit(2)
}

const step = message => console.log(`ok  ${message}`)
const browser = await chromium.launch()
const context = await browser.newContext({ acceptDownloads: true, permissions: ["clipboard-read", "clipboard-write"] })
const page = await context.newPage()
const cdp = await context.newCDPSession(page)
await cdp.send("WebAuthn.enable")
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
})

try {
  await page.goto(`${nas}/?setup=${token}`)
  await page.getByRole("button", { name: "註冊" }).click()
  await page.getByRole("tab", { name: "檔案" }).waitFor()
  step("registered a passkey and signed in")

  await page.getByRole("button", { name: "登出" }).click()
  await page.getByRole("button", { name: "登入" }).click()
  await page.getByRole("tab", { name: "檔案" }).waitFor()
  step("signed out and back in with the passkey")

  await page.getByRole("button", { name: "新資料夾" }).click()
  await page.getByLabel("名稱").fill("照片")
  await page.getByRole("button", { name: "建立" }).click()
  await page.getByRole("button", { name: "照片", exact: true }).click()
  await page.locator("input[type=file]").setInputFiles({ name: "報告.txt", mimeType: "text/plain", buffer: Buffer.from("hello from nas") })
  await page.getByRole("link", { name: "報告.txt" }).waitFor()
  step("created a folder and uploaded a file into it")

  await page.getByRole("button", { name: "報告.txt 的操作" }).click()
  await page.getByRole("menuitem", { name: "分享" }).click()
  await page.getByRole("button", { name: "建立連結" }).click()
  const url = await page.locator("ul[aria-label=有效連結] li p").first().innerText()
  if (!url.startsWith(`${shareOrigin}/`)) throw new Error(`unexpected share url ${url}`)
  step(`created ${url}`)

  const visitor = await browser.newContext({ acceptDownloads: true })
  const guest = await visitor.newPage()
  await guest.goto(url)
  await guest.getByRole("heading", { name: "報告.txt" }).waitFor()
  const [download] = await Promise.all([guest.waitForEvent("download"), guest.getByRole("link", { name: "下載" }).click()])
  const text = await (await import("node:fs/promises")).readFile(await download.path(), "utf8")
  if (text !== "hello from nas" || download.suggestedFilename() !== "報告.txt") throw new Error(`bad download ${download.suggestedFilename()} ${text}`)
  step("a visitor without a session opened the link and downloaded the file")

  await page.getByRole("button", { name: "撤銷" }).first().click()
  await page.getByRole("alertdialog").getByRole("button", { name: "撤銷" }).click()
  await page.getByRole("alertdialog").waitFor({ state: "detached" })
  await guest.reload()
  await guest.getByRole("heading", { name: "連結無效" }).waitFor()
  step("the revoked link shows 連結無效")
  await visitor.close()
} finally {
  await browser.close()
}
