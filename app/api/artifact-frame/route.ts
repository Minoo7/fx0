import { DESIGN_ARTIFACT_EMBEDDED_CSP, DESIGN_FRAME_CSP, designFrameHtml, prepareDesignArtifactHtml, remoteImagesEnabled } from '../../../lib/design-artifact'
import { embedRemoteImages } from '../../../lib/remote-image'
import { cachedRemoteImage } from '../../../lib/remote-image-cache'
import { readDesignArtifactAt } from '../../../lib/journal'
import { readGeneration } from '../../../lib/history'
import { withSessionRoute } from '../../../lib/route-auth'
import { log } from '../../../lib/session'

export const maxDuration = 30

export const GET = withSessionRoute(async (request, { id: sessionId, user }) => {
  // Without a revision this is the live design in Redis; with one, a past version from Neon.
  const params = new URL(request.url).searchParams
  const revision = Number(params.get('revision'))
  const past = Number.isSafeInteger(revision) && revision > 0
  const live = past ? null : await readDesignArtifactAt(sessionId)
  const artifact = past ? await readGeneration(user.id, sessionId, revision) : live!.html
  // ?v= names the revision the page expects. When it is the one live, the browser may
  // keep this response but must revalidate it: this route checks the session first,
  // so a reload costs a 304 and a signed-out browser gets nothing from its cache.
  const version = Number(params.get('v'))
  const cacheable = live?.html != null && Number.isSafeInteger(version) && version > 0 && version === live.revision
  const etag = cacheable ? `"${sessionId}:${live.revision}"` : null
  if (etag && request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { 'cache-control': 'private, no-cache', etag } })
  }
  const readyToken = crypto.randomUUID()
  // Remote images are fetched here and embedded as data: URLs, so the design has no
  // network while it runs (lib/remote-image.ts). A copy missing an image is not kept.
  const embedStarted = performance.now()
  const embedded = artifact != null && remoteImagesEnabled()
    ? await embedRemoteImages(artifact, cachedRemoteImage)
    : { html: artifact, complete: true, images: 0 }
  const embedMs = Math.round(performance.now() - embedStarted)
  const keep = etag != null && embedded.complete
  const prepared = embedded.html == null ? null : prepareDesignArtifactHtml(embedded.html, DESIGN_ARTIFACT_EMBEDDED_CSP, readyToken)
  // Every stored design passed validation, so this only guards against one that
  // somehow lacks a doctype: it is never shown without its CSP.
  if (artifact != null && prepared == null) log(sessionId, 'artifact:unrenderable', { revision: past ? revision : live!.revision })
  const preparedArtifact = prepared ??
    `<!doctype html><html><head><meta charset="utf-8"><title>No design artifact</title></head><body><p>${
      artifact != null ? 'This design could not be prepared for preview.'
        : past ? 'This version is not in the history.' : 'No design artifact has been published for this session.'
    }</p></body></html>`
  const html = designFrameHtml(preparedArtifact, readyToken)
  // Streamed: embedded images can take it past the buffered response limit.
  const bytes = new TextEncoder().encode(html)
  if (embedded.images) log(sessionId, 'artifact:images', { images: embedded.images, complete: embedded.complete, embedMs, bytes: bytes.length })
  const body = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } })
  return new Response(body, {
    status: artifact == null ? 404 : 200,
    headers: {
      'cache-control': keep ? 'private, no-cache' : 'private, no-store',
      ...(keep ? { etag } : {}),
      'content-security-policy': DESIGN_FRAME_CSP,
      'content-type': 'text/html; charset=utf-8',
      'permissions-policy':
        'accelerometer=(), camera=(), clipboard-read=(), clipboard-write=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), usb=()',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  })
})
