// A JSON cache in the temp dir, for lists that are slow to build and fine to reuse (indexer listings)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DIR = join(tmpdir(), "abel-dt-demos")

/** `build()`'s result, cached as `<name>.json` until `refresh` */
export async function cached<T>(name: string, build: () => Promise<T>, { refresh = false }: { refresh?: boolean } = {}): Promise<T> {
  const path = join(DIR, `${name}.json`)
  if (!refresh && existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as T
  const value = await build()
  mkdirSync(DIR, { recursive: true })
  writeFileSync(path, JSON.stringify(value))
  return value
}
