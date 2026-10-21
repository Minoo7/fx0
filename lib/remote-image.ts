// @ts-expect-error Node strip-types tests require the source extension.
import { BLANK_IMAGE, rewriteRemoteImages } from './design-artifact.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { sniffImageType } from './image-sniff.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { fetchPublicImage, MAX_IMAGE_FETCH_BYTES } from './public-fetch.ts'

// A design never touches the network while it runs: a script could choose which
// requests to make and so leak what the viewer types. fx0 fetches the remote images
// the stored markup names, before the design runs, and embeds them as data: URLs.
// What is fetched depends only on the stored design, never on the viewer.

export const MAX_REMOTE_IMAGES = 12
export const MAX_REMOTE_IMAGES_TOTAL_BYTES = 4 * 1024 * 1024

/** One remote image as a data: URL. Throws when it is unreachable, too large or not an image. */
export async function loadRemoteImage(url: string): Promise<string> {
  const { body } = await fetchPublicImage(url, AbortSignal.timeout(5_000))
  const type = sniffImageType(body)
  if (!type) throw new Error('Not an image')
  return `data:${type};base64,${body.toString('base64')}`
}

/**
 * The design with its remote images embedded, in document order, within the count
 * and size budgets; any other one becomes a blank image. `complete` is false when an
 * image failed, so the caller does not let a browser keep that copy.
 */
export async function embedRemoteImages(html: string, load: (url: string) => Promise<string>): Promise<{ html: string; complete: boolean }> {
  const urls: string[] = []
  rewriteRemoteImages(html, (url: string) => {
    if (!urls.includes(url)) urls.push(url)
    return BLANK_IMAGE
  })
  if (!urls.length) return { html, complete: true }
  const wanted = urls.slice(0, MAX_REMOTE_IMAGES)
  const loaded = await Promise.all(wanted.map((url) => load(url).catch(() => null)))
  const embedded = new Map<string, string>()
  let total = 0
  for (const [index, image] of loaded.entries()) {
    if (!image) continue
    const bytes = Math.floor((image.length - image.indexOf(',') - 1) * 3 / 4)
    if (bytes > MAX_IMAGE_FETCH_BYTES || total + bytes > MAX_REMOTE_IMAGES_TOTAL_BYTES) continue
    total += bytes
    embedded.set(wanted[index], image)
  }
  const complete = loaded.every(Boolean)
  return { html: rewriteRemoteImages(html, (url: string) => embedded.get(url) ?? BLANK_IMAGE), complete }
}
