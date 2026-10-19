import { DESIGN_ARTIFACT_EMBEDDED_CSP, prepareDesignArtifactHtml } from '../../../lib/design-artifact'
import { readDesignArtifactAt } from '../../../lib/journal'
import { readGeneration } from '../../../lib/history'
import { withSessionRoute } from '../../../lib/route-auth'

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
  const preparedArtifact = artifact == null
    ? `<!doctype html><html><head><meta charset="utf-8"><title>No design artifact</title></head><body><p>${
      past ? 'This version is not in the history.' : 'No design artifact has been published for this session.'
    }</p></body></html>`
    : prepareDesignArtifactHtml(artifact, DESIGN_ARTIFACT_EMBEDDED_CSP, readyToken)
  const artifactUrl = `data:text/html;base64,${Buffer.from(preparedArtifact, 'utf8').toString('base64')}`
  const csp = [
    "default-src 'none'",
    'frame-src data:',
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join('; ')
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
  // The design cannot open popups itself; a clicked https link is opened here, without
  // an opener, and only during the click's user activation (it propagates to this frame).
  if(event.data.type==='open'&&typeof event.data.url==='string'&&navigator.userActivation?.isActive!==false){
    try{
      const url=new URL(event.data.url);
      if(url.protocol==='https:'&&!url.username&&!url.password)window.open(url.href,'_blank','noopener,noreferrer');
    }catch{}
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
  return new Response(html, {
    status: artifact == null ? 404 : 200,
    headers: {
      'cache-control': etag ? 'private, no-cache' : 'private, no-store',
      ...(etag ? { etag } : {}),
      'content-security-policy': csp,
      'content-type': 'text/html; charset=utf-8',
      'permissions-policy':
        'accelerometer=(), camera=(), clipboard-read=(), clipboard-write=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), usb=()',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  })
})
