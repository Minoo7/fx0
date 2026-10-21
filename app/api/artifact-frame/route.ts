import { DESIGN_ARTIFACT_EMBEDDED_CSP, DESIGN_FRAME_CSP, prepareDesignArtifactHtml, remoteImagesEnabled } from '../../../lib/design-artifact'
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
  const embedded = artifact != null && remoteImagesEnabled()
    ? await embedRemoteImages(artifact, cachedRemoteImage)
    : { html: artifact, complete: true }
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
  const artifactUrl = `data:text/html;base64,${Buffer.from(preparedArtifact, 'utf8').toString('base64')}`
  const serializedArtifactUrl = JSON.stringify(artifactUrl)
  const serializedReadyToken = JSON.stringify(readyToken)
  // The wrapper paints nothing of its own, so a design that has not painted yet
  // shows the app's background. Sharing the app's color scheme keeps it
  // transparent; a design that sets no background still gets the browser's white.
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Design artifact preview</title>
<style>:root{color-scheme:light dark}html,body,#frame-root,iframe{width:100%;height:100%;margin:0;border:0;overflow:hidden}</style>
</head>
<body>
<div id="frame-root"></div>
<script>
const artifact=${serializedArtifactUrl};
const token=${serializedReadyToken};
const frame=document.createElement('iframe');
frame.title='Interactive design artifact';
frame.setAttribute('sandbox','allow-scripts');
frame.referrerPolicy='no-referrer';
frame.setAttribute('credentialless','');
let readySignals=0;
let consumedSignals=0;
let lastHeartbeat=Date.now();
const restore=()=>{lastHeartbeat=Date.now();frame.src=artifact;};
addEventListener('message',event=>{
  if(event.source!==frame.contentWindow||event.data?.token!==token)return;
  lastHeartbeat=Date.now();
  if(event.data.type==='ready')readySignals++;
  // The design paints in its own process, after this wrapper's load event; the app
  // swaps a new revision on screen only once it has.
  if(event.data.type==='painted')parent.postMessage({type:'fx0-artifact-painted'},location.origin);
  // The design can only ask to open a link: its scripts can read the token and send
  // this at any time. The app shows the address and opens it on the user's own click
  // there. Recent user activation only filters out asks nobody prompted; it is not proof.
  if(event.data.type==='open'&&typeof event.data.url==='string'&&navigator.userActivation?.isActive!==false){
    parent.postMessage({type:'fx0-artifact-open',url:event.data.url},location.origin);
  }
});
frame.addEventListener('load',()=>setTimeout(()=>{
  if(readySignals>consumedSignals){consumedSignals=readySignals;return;}
  restore();
},100));
setInterval(()=>{
  if(document.visibilityState==='visible'&&Date.now()-lastHeartbeat>3000)restore();
},500);
frame.src=artifact;
document.querySelector('#frame-root').append(frame);
</script>
</body>
</html>`
  // Streamed: embedded images can take it past the buffered response limit.
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(html)); controller.close() } })
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
