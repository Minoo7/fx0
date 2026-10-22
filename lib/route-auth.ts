import { AuthError, assertSessionOwner, isNewSessionId, ownedSessionPage, reserveSession, validSessionId, type AccountUser } from './accounts'
import { assertSameOrigin, publicUser, tailnetSession, type TailnetSession } from './tailnet-auth'
import { getSession } from './session'
import { readSessionSummaries, sessionExists } from './journal'
import type { SessionPage } from './events'
import type { SessionState } from './session'

export interface UserRouteContext { session: TailnetSession; user: AccountUser }
export interface SessionRouteContext extends UserRouteContext { id: string; host: SessionState; created: boolean }
export interface PromptRouteContext extends UserRouteContext {
  existing: SessionRouteContext | null
  activate(): Promise<SessionRouteContext>
}

export function withUserRoute(body: (request: Request, context: UserRouteContext) => Response | Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    try {
      const session = tailnetSession(request.headers)
      if (request.method !== 'GET' && request.method !== 'HEAD') assertSameOrigin(request)
      const response = await body(request, { session, user: publicUser(session) })
      response.headers.set('cache-control', 'private, no-store')
      return response
    } catch (error) {
      return Response.json({ error: error instanceof AuthError ? error.message : 'Request failed' }, {
        status: error instanceof AuthError ? error.status : 503,
        headers: { 'cache-control': 'private, no-store' },
      })
    }
  }
}

async function ownedSession(request: Request, context: UserRouteContext): Promise<SessionRouteContext> {
  const id = new URL(request.url).searchParams.get('session')
  if (!validSessionId(id)) throw new AuthError(404, 'Session not found')
  await assertSessionOwner(context.user.id, id)
  const host = getSession(id)
  host.ownerId = context.user.id
  return { ...context, id, host, created: false }
}

export function withSessionRoute(body: (request: Request, context: SessionRouteContext) => Response | Promise<Response>) {
  return withUserRoute(async (request, context) => body(request, await ownedSession(request, context)))
}

export function withPromptRoute(body: (request: Request, context: PromptRouteContext) => Response | Promise<Response>) {
  return withUserRoute(async (request, context) => {
    if (new URL(request.url).searchParams.get('session') !== 'new') {
      const existing = await ownedSession(request, context)
      return body(request, { ...context, existing, activate: async () => existing })
    }
    return body(request, { ...context, existing: null, activate: async () => {
      const id = await reserveNewSession(context.user)
      const host = getSession(id)
      host.ownerId = context.user.id
      return { ...context, id, host, created: true }
    } })
  })
}

export async function reserveNewSession(user: AccountUser, id = crypto.randomUUID()): Promise<string> {
  if (!isNewSessionId(id)) throw new AuthError(400, 'New sessions require a UUID')
  if (await sessionExists(id)) throw new AuthError(404, 'Session not found')
  await reserveSession(user, id, null)
  return id
}

export async function listOwnedSessions(userId: string, cursor?: string | null): Promise<SessionPage> {
  const { ids, nextCursor } = await ownedSessionPage(userId, cursor)
  return { sessions: await readSessionSummaries(ids), nextCursor, now: Date.now() }
}
