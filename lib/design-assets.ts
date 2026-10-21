import { randomBytes } from 'node:crypto'
import { del, get, list, put } from '@vercel/blob'
import { MAX_CHAT_ASSETS, MAX_DAILY_ASSETS, readDesignAssets, recordDesignAssets, releaseDesignAssets, reserveDesignAssets } from './journal'
import type { PromptImage } from './prompt-images'

// Images a message attached, kept in fx0's private Blob store so a design can show them
// (as fx0-asset:<handle>). The chat's manifest in Redis is the access check: only a
// handle recorded for the chat is ever read, and deleting the chat removes it.

export interface DesignAssetStore {
  put: typeof put
  get: typeof get
  del: typeof del
  list: typeof list
}

const BLOB: DesignAssetStore = { put, get, del, list }

export interface DesignAssetQuota {
  reserve: typeof reserveDesignAssets
  release: typeof releaseDesignAssets
}

const QUOTA: DesignAssetQuota = { reserve: reserveDesignAssets, release: releaseDesignAssets }

/** A message that would pass the per-chat or per-day image cap. Nothing was stored. */
export class DesignAssetLimitError extends Error {
  constructor(limit: 'chat' | 'daily') {
    super(limit === 'chat'
      ? `This chat already has its ${MAX_CHAT_ASSETS} attached images. Start a new design to attach more.`
      : `You can attach up to ${MAX_DAILY_ASSETS} images a day. Try again tomorrow.`)
  }
}

const pathname = (sessionId: string, handle: string) => `chats/${sessionId}/${handle}`

/**
 * Stores a message's images and records them for the chat, all or none, within the
 * chat's and the user's caps. Returns their handles in order.
 */
export async function storeDesignAssets(sessionId: string, userId: string, images: PromptImage[], store = BLOB, quota = QUOTA): Promise<string[]> {
  if (!images.length) return []
  const reserved = await quota.reserve(sessionId, userId, images.length)
  if (reserved !== 'ok') throw new DesignAssetLimitError(reserved)
  try {
    return await storeReserved(sessionId, images, store)
  } catch (error) {
    await quota.release(sessionId, userId, images.length).catch(() => {})
    throw error
  }
}

async function storeReserved(sessionId: string, images: PromptImage[], store: DesignAssetStore): Promise<string[]> {
  const assets = images.map((image) => ({
    handle: randomBytes(18).toString('base64url'),
    mimeType: image.mimeType,
    bytes: Buffer.from(image.data, 'base64'),
  }))
  const results = await Promise.allSettled(assets.map(({ handle, mimeType, bytes }) =>
    store.put(pathname(sessionId, handle), bytes, { access: 'private', contentType: mimeType, addRandomSuffix: false })))
  if (results.some((result) => result.status === 'rejected')) {
    const stored = assets.filter((_, index) => results[index].status === 'fulfilled').map(({ handle }) => pathname(sessionId, handle))
    if (stored.length) await store.del(stored).catch(() => {})
    throw new Error('Unable to store the attached images')
  }
  await recordDesignAssets(sessionId, assets.map(({ handle, mimeType, bytes }) => ({ handle, mimeType, bytes: bytes.length })))
  return assets.map(({ handle }) => handle)
}

/** One of the chat's images, or null when the chat never received that handle. */
export async function readDesignAsset(sessionId: string, handle: string, store = BLOB): Promise<{ bytes: Buffer; mimeType: string } | null> {
  const asset = (await readDesignAssets(sessionId, [handle])).get(handle)
  if (!asset) return null
  const result = await store.get(pathname(sessionId, handle), { access: 'private' })
  if (!result || result.statusCode !== 200) return null
  return { bytes: Buffer.from(await new Response(result.stream).arrayBuffer()), mimeType: asset.mimeType }
}

/** Removes every stored image of a deleted chat. */
export async function deleteDesignAssets(sessionId: string, store = BLOB): Promise<void> {
  // Listed whole before deleting: deleting while paging would move the cursor past files.
  const pathnames: string[] = []
  let cursor: string | undefined
  do {
    const page = await store.list({ prefix: `chats/${sessionId}/`, cursor, limit: 1000 })
    pathnames.push(...page.blobs.map((blob) => blob.pathname))
    cursor = page.hasMore ? page.cursor : undefined
  } while (cursor)
  for (let index = 0; index < pathnames.length; index += 1000) await store.del(pathnames.slice(index, index + 1000))
}
