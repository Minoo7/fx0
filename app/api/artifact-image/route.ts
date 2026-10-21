import { verifyArtifactImage } from '../../../lib/artifact-image'
import { assetReference } from '../../../lib/design-artifact'
import { readDesignAsset } from '../../../lib/design-assets'
import { cachedRemoteImage } from '../../../lib/remote-image-cache'
import { withSessionRoute } from '../../../lib/route-auth'
import { log } from '../../../lib/session'

export const maxDuration = 30

// One image of a design, remote or attached, for the wrapper artifact-frame serves (see lib/artifact-image.ts).
// The design itself never reaches this route: its CSP allows no connections and its
// frame is credentialless. The bytes come from the shared cache artifact-frame warms.
export const GET = withSessionRoute(async (request, { id: sessionId }) => {
  const params = new URL(request.url).searchParams
  const url = verifyArtifactImage(sessionId, params.get('u'), params.get('sig'))
  if (!url) return new Response(null, { status: 404, headers: { 'cache-control': 'private, no-store' } })
  let image: { bytes: Buffer; mimeType: string } | null
  try {
    const asset = assetReference(url)
    if (asset) image = await readDesignAsset(sessionId, asset.slice('fx0-asset:'.length))
    else {
      const data = await cachedRemoteImage(url)
      image = { bytes: Buffer.from(data.slice(data.indexOf(',') + 1), 'base64'), mimeType: data.slice('data:'.length, data.indexOf(';')) }
    }
  } catch (error) {
    log(sessionId, 'artifact-image:failed', { image: assetReference(url) ? 'asset' : new URL(url).host, reason: (error as Error).message.slice(0, 80) })
    image = null
  }
  if (!image) return new Response(null, { status: 404, headers: { 'cache-control': 'private, no-store' } })
  return new Response(new Uint8Array(image.bytes), {
    headers: {
      'content-type': image.mimeType,
      'cache-control': 'private, max-age=86400',
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
    },
  })
})
