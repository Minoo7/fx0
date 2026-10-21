import { sniffImageType } from '../../../../lib/image-sniff'
import { fetchPublicImage } from '../../../../lib/public-fetch'
import { remoteImagesEnabled, verifyRemoteImage } from '../../../../lib/remote-image'

export const maxDuration = 15

// A 1x1 transparent GIF: a broken or refused image never breaks the design's layout,
// and the response never says why.
const BLANK = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

// No cookies or session: the design's frame is credentialless and has an opaque origin.
// The signature is the authorization, and it covers this exact URL until it expires.
// Responses must never be read as anything but an image, even when opened directly.
const IMAGE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
  'cross-origin-resource-policy': 'cross-origin',
  'referrer-policy': 'no-referrer',
}

function blank(): Response {
  return new Response(BLANK, { headers: { ...IMAGE_HEADERS, 'content-type': 'image/gif', 'cache-control': 'no-store' } })
}

export async function GET(request: Request, context: RouteContext<'/api/remote-image/[sig]'>) {
  const params = new URL(request.url).searchParams
  const { sig } = await context.params
  if (!remoteImagesEnabled()) return blank()
  // Exactly the two signed parameters: a design cannot append data to a signed URL.
  const keys = [...params.keys()]
  const exact = keys.length === 2 && params.getAll('exp').length === 1 && params.getAll('u').length === 1
  const url = exact ? verifyRemoteImage(sig, params.get('exp'), params.get('u')) : null
  if (!url) return blank()
  const started = performance.now()
  try {
    const { body } = await fetchPublicImage(url, AbortSignal.timeout(10_000))
    const type = sniffImageType(body)
    if (!type) {
      console.warn('[fx0] remote image refused', { host: new URL(url).host, reason: 'type' })
      return blank()
    }
    console.log('[fx0] remote image', { host: new URL(url).host, bytes: body.length, ms: Math.round(performance.now() - started) })
    // Streamed, so a large image is not held to the buffered response limit.
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(body)); controller.close() } })
    return new Response(stream, {
      headers: {
        ...IMAGE_HEADERS,
        'content-type': type,
        'content-length': String(body.length),
        'cache-control': 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800',
      },
    })
  } catch (error) {
    console.warn('[fx0] remote image failed', { host: new URL(url).host, reason: (error as Error).message.slice(0, 80) })
    return blank()
  }
}
