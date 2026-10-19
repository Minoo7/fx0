import { readDesignArtifact } from '../../../lib/journal'
import { readGeneration } from '../../../lib/history'
import { withSessionRoute } from '../../../lib/route-auth'

export const maxDuration = 30

// A design's own HTML, for copying or saving. It is model-written, so this origin never
// renders it: plain text, an attachment, and a sandboxing policy. Its scripts run only
// inside the preview's sandboxed frame.
export const GET = withSessionRoute(async (request, { id: sessionId, user }) => {
  // Without a revision this is the live design in Redis; with one, a past version from Neon.
  const revision = Number(new URL(request.url).searchParams.get('revision'))
  const past = Number.isSafeInteger(revision) && revision > 0
  const html = past ? await readGeneration(user.id, sessionId, revision) : await readDesignArtifact(sessionId)
  if (html == null) {
    return Response.json({ error: past ? 'This version is not in the history.' : 'No design has been published yet.' }, { status: 404 })
  }
  return new Response(html, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': 'attachment; filename="design.html"',
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
    },
  })
})
