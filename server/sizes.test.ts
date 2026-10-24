import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDb } from "./db"
import { createSizes } from "./sizes"

let dir: string
let sizes: ReturnType<typeof createSizes>

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "nas-sizes-"))
  mkdirSync(join(dir, "root/a/b"), { recursive: true })
  writeFileSync(join(dir, "root/a/x.txt"), "12")
  writeFileSync(join(dir, "root/a/b/y.txt"), "345")
  sizes = createSizes(join(dir, "root"), openDb(join(dir, "nas.db")))
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

test("sizes sum files below a folder and are cached", async () => {
  expect(await sizes.get("a")).toBe(5)
  expect(await sizes.get("a/b")).toBe(3)
  writeFileSync(join(dir, "root/a/b/z.txt"), "6789")
  expect(await sizes.get("a")).toBe(5)
})

test("a write drops the cache of every folder above it", async () => {
  sizes.changed("a/b/z.txt")
  expect(await sizes.get("a/b")).toBe(7)
  expect(await sizes.get("a")).toBe(9)
})

test("reconcile picks up changes made outside the app", async () => {
  writeFileSync(join(dir, "root/a/b/w.txt"), "0")
  expect(await sizes.get("a")).toBe(9)
  await sizes.reconcile()
  expect(await sizes.get("a")).toBe(10)
  expect(await sizes.get("")).toBe(10)
})

test("a removed folder leaves no cache behind", async () => {
  sizes.removed("a/b")
  rmSync(join(dir, "root/a/b"), { recursive: true })
  expect(await sizes.get("a")).toBe(2)
  mkdirSync(join(dir, "root/a/b"))
  sizes.changed("a/b")
  expect(await sizes.get("a/b")).toBe(0)
})
