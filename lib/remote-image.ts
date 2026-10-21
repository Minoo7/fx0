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
// Counted per place an image is written. With the 512 KiB design limit this bounds a
// prepared preview to about 6 MiB, and the artifact-frame response to about 8 MiB.
export const MAX_REMOTE_IMAGES_TOTAL_BYTES = 4 * 1024 * 1024

/** One remote image as a data: URL. Throws when it is unreachable, too large or not an image. */
export async function loadRemoteImage(url: string): Promise<string> {
  const { body } = await fetchPublicImage(url, AbortSignal.timeout(5_000))
  const type = sniffImageType(body)
  if (!type) throw new Error('Not an image')
  return `data:${type};base64,${body.toString('base64')}`
}

/**
 * The design with its remote images embedded, within the count and size budgets; any
 * other one becomes a blank image. The size budget counts every place an image is
 * written, since each one carries the whole image, so a repeated image cannot expand
 * the preview past it. `complete` is false when an image failed to load, so the
 * caller does not let a browser keep that copy.
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
  for (const [index, image] of loaded.entries()) {
    if (image && imageBytes(image) <= MAX_IMAGE_FETCH_BYTES) embedded.set(wanted[index], image)
  }
  let total = 0
  const rewritten = rewriteRemoteImages(html, (url: string) => {
    const image = embedded.get(url)
    if (!image || total + imageBytes(image) > MAX_REMOTE_IMAGES_TOTAL_BYTES) return BLANK_IMAGE
    total += imageBytes(image)
    return image
  })
  return { html: rewritten, complete: loaded.every(Boolean) }
}

function imageBytes(image: string): number {
  return Math.floor((image.length - image.indexOf(',') - 1) * 3 / 4)
}
