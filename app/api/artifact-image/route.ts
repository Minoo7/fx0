import { verifyArtifactImage } from '../../../lib/artifact-image'
import { cachedRemoteImage } from '../../../lib/remote-image-cache'
import { withSessionRoute } from '../../../lib/route-auth'
import { log } from '../../../lib/session'

export const maxDuration = 30

// One image of a design, for the wrapper artifact-frame serves (see lib/artifact-image.ts).
// The design itself never reaches this route: its CSP allows no connections and its
// frame is credentialless. The bytes come from the shared cache artifact-frame warms.
export const GET = withSessionRoute(async (request, { id: sessionId }) => {
  const params = new URL(request.url).searchParams
  const url = verifyArtifactImage(sessionId, params.get('u'), params.get('sig'))
  if (!url) return new Response(null, { status: 404, headers: { 'cache-control': 'private, no-store' } })
  let image: string
  try {
    image = await cachedRemoteImage(url)
  } catch (error) {
    log(sessionId, 'artifact-image:failed', { host: new URL(url).host, reason: (error as Error).message.slice(0, 80) })
    return new Response(null, { status: 404, headers: { 'cache-control': 'private, no-store' } })
  }
  const comma = image.indexOf(',')
  return new Response(Buffer.from(image.slice(comma + 1), 'base64'), {
    headers: {
      'content-type': image.slice('data:'.length, image.indexOf(';')),
      'cache-control': 'private, max-age=86400',
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
    },
  })
})
