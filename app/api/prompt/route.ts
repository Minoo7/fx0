import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { after } from 'next/server'
import { createSessionEventStream } from '../../../lib/event-stream'
import { followChat, submitPrompt } from '../../../lib/agent'
import { parseDesignMdRequest } from '../../../lib/design-md'
import { withPromptRoute } from '../../../lib/route-auth'
import { touchOwnedSession, AuthError } from '../../../lib/accounts'
import { DEFAULT_MODEL, effectiveModel, log } from '../../../lib/session'
import { validatePromptImages, validatePromptPreviews } from '../../../lib/prompt-images'
import { DesignAssetLimitError, retryDesignAssetCleanup, startDesignAssets } from '../../../lib/design-assets'
import { PROMPT_TEXT_LIMIT_ERROR, PROMPT_TEXT_MAX_BYTES, promptTextBytes } from '../../../lib/prompt-limits'
import { assertModelAccess } from '../../../lib/pi-models'

export const maxDuration = 800
export const POST = withPromptRoute(async (request, context) => {
  const { user } = context
  let body
  try { body = await request.json() } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  const checked = validatePromptImages(body?.images)
  if ('error' in checked) return Response.json({ error: checked.error }, { status: 413 })
  const images = checked.images.length ? checked.images : undefined
  if (!text && !images) return Response.json({ error: 'Empty prompt' }, { status: 400 })
  if (promptTextBytes(text) > PROMPT_TEXT_MAX_BYTES) return Response.json({ error: PROMPT_TEXT_LIMIT_ERROR }, { status: 413 })
  const previews = validatePromptPreviews(body?.previews, images?.length ?? 0)
  const generation = body?.generation && typeof body.generation === 'object' ? body.generation : {}
  const designRequest = parseDesignMdRequest(body?.designMd)
  if (designRequest && 'error' in designRequest) return Response.json({ error: designRequest.error }, { status: 400 })
  const designMd = !designRequest ? null : 'option' in designRequest
    ? { name: designRequest.option.name, source: `getdesign:${designRequest.option.id}`,
      text: await readFile(path.join(process.cwd(), 'lib', 'design-md', `${designRequest.option.id}.md`), 'utf8') }
    : designRequest.upload
  const initial = {
    preferredModel: typeof generation.model === 'string' && generation.model.trim() ? generation.model.trim().slice(0, 200) : null,
    preferredEffort: typeof generation.effort === 'string' && generation.effort.trim() ? generation.effort.trim().slice(0, 32) : null,
    preferredFast: false,
    designMd,
  }
  // Reject missing provider credentials before reserving a new chat or storing images.
  if (!context.existing || images) await assertModelAccess(context.existing
    ? effectiveModel(context.existing.host) : initial.preferredModel ?? process.env.FX0_MODEL ?? DEFAULT_MODEL)
  const activated = await context.activate()
  let submitted
  try {
    const assets = images ? await startDesignAssets(activated.id, user.id, images) : undefined
    if (images) after(() => retryDesignAssetCleanup().catch(() => console.error('[fx0] asset cleanup retry unavailable')))
    submitted = await submitPrompt(activated.host, (user.name || user.email || user.id).slice(0, 24), text,
      typeof body.clientId === 'string' ? body.clientId.slice(0, 40) : undefined, images, context.existing ? undefined : initial,
      previews.length ? previews : undefined, assets)
  } catch (error) {
    if (error instanceof DesignAssetLimitError) throw new AuthError(429, error.message)
    throw error
  }
  const { id, seq } = submitted
  const { host, id: sessionId, created } = activated
  log(sessionId, 'prompt:route', { id, created })
  after(() => followChat(host))
  after(() => touchOwnedSession(user.id, sessionId, text, Date.now()).catch(() => console.error('[fx0] chat activity update failed')))
  let doneId = id
  const stream = createSessionEventStream(sessionId, {
    maxIdleMs: 300,
    afterSeq: typeof body.afterSeq === 'number' && Number.isSafeInteger(body.afterSeq) && body.afterSeq >= 0
      ? Math.min(body.afterSeq, Math.max(0, seq - 1)) : Math.max(0, seq - 1),
    wake: () => void followChat(host),
    closeWhen(item) {
      if (item.type === 'status' && item.id === id && item.turnId != null) doneId = item.turnId
      return (item.type === 'done' && item.id === doneId) || (item.type === 'error' && (item.id === id || item.id === doneId))
    },
  })
  return new Response(stream.pipeThrough(new TextEncoderStream()), { headers: {
    ...(created ? { 'x-fx0-session': sessionId } : {}), 'x-fx0-trial-chat': '0',
    'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no',
  } })
})
