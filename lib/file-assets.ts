import { mkdir, readFile, readdir, rm, writeFile, rename } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DesignAssetStore } from './design-assets'

function assetPath(key: string): string {
  const root = resolve(process.env.FX0_DATA_DIR ?? '.data', 'assets')
  const path = resolve(root, key)
  if (!path.startsWith(root + sep)) throw new Error('Invalid asset path')
  return path
}

export const fileAssets: DesignAssetStore = {
  async put(key, bytes) {
    const path = assetPath(key)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, bytes, { mode: 0o600 })
    await rename(temporary, path)
  },
  async get(key) {
    try {
      const bytes = await readFile(assetPath(key))
      return { statusCode: 200, stream: new Blob([new Uint8Array(bytes)]).stream() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  },
  async del(keys) { await Promise.all(keys.map(key => rm(assetPath(key), { force: true }))) },
  async list({ prefix, cursor, limit }) {
    const directory = assetPath(prefix)
    let files: string[]
    try { files = (await readdir(directory)).filter(name => !name.endsWith('.tmp')).sort() } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { blobs: [], hasMore: false }
      throw error
    }
    const after = cursor ? files.filter(name => name > cursor) : files
    const selected = after.slice(0, limit)
    return { blobs: selected.map(name => ({ pathname: `${prefix}${name}` })), hasMore: after.length > limit,
      cursor: selected.at(-1) }
  },
}
