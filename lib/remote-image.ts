import { createHmac, timingSafeEqual } from 'node:crypto'

// A design shows remote images only through /api/remote-image, at URLs this server
// signed while preparing the preview. Scripts in the design cannot sign, so they can
// load only the images its markup named and cannot carry data out in a new URL.

export const REMOTE_IMAGE_PATH = '/api/remote-image/'
export const MAX_REMOTE_IMAGE_URL_LENGTH = 2048

const DAY_MS = 24 * 3600_000
// Signed URLs stay the same for a day (so the CDN can cache them) and work for at
// least seven more; a cached preview revalidates daily and receives fresh ones.
const VALID_DAYS = 8

export function remoteImagesEnabled(): boolean {
  return process.env.FX0_REMOTE_IMAGES !== '0'
}

/** The URL fx0 will sign and fetch: absolute https, no credentials, bounded; else null. */
export function remoteImageUrl(value: string): string | null {
  if (!/^https:\/\//i.test(value) || value.length > MAX_REMOTE_IMAGE_URL_LENGTH) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return null
  return url.href.length <= MAX_REMOTE_IMAGE_URL_LENGTH ? url.href : null
}

export function remoteImageEpoch(now = Date.now()): number {
  return Math.floor(now / DAY_MS)
}

function signingKey(): Buffer {
  const secret = process.env.SESSION_SECRET
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters')
  return createHmac('sha256', secret).update('fx0 remote-image signing key v1').digest()
}

function signature(expires: number, url: string): Buffer {
  return createHmac('sha256', signingKey()).update(`v1:remote-image:${expires}:${url}`).digest()
}

/** An absolute proxy URL for `url` (already normalized by remoteImageUrl). */
export function signRemoteImage(origin: string, url: string, now = Date.now()): string {
  const expires = (remoteImageEpoch(now) + VALID_DAYS) * (DAY_MS / 1000)
  const sig = signature(expires, url).toString('base64url')
  // Also encodes ! ' ( ) *, so the URL can sit unquoted in CSS url() and in any attribute.
  const encoded = encodeURIComponent(url).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${origin}${REMOTE_IMAGE_PATH}${sig}?exp=${expires}&u=${encoded}`
}

/** The URL a signed proxy request may fetch, or null. */
export function verifyRemoteImage(sig: string, exp: string | null, value: string | null, now = Date.now()): string | null {
  if (!exp || !/^\d{1,12}$/.test(exp) || value == null) return null
  const expires = Number(exp)
  const remainingMs = expires * 1000 - now
  if (remainingMs <= 0 || remainingMs > (VALID_DAYS + 1) * DAY_MS) return null
  const url = remoteImageUrl(value)
  if (!url || url !== value) return null
  if (!/^[A-Za-z0-9_-]{43}$/.test(sig)) return null
  const given = Buffer.from(sig, 'base64url')
  const expected = signature(expires, url)
  return given.length === expected.length && timingSafeEqual(given, expected) ? url : null
}
