import { listOwnedSessions, reserveNewSession, withUserRoute } from '../../../lib/route-auth'

export const maxDuration = 60

export const GET = withUserRoute(async (request, { user }) => {
  return Response.json(await listOwnedSessions(user.id, new URL(request.url).searchParams.get('cursor')))
})

export const POST = withUserRoute(async (_request, { user }) => {
  const id = await reserveNewSession(user)
  return Response.json({ id, sessionId: id }, { status: 201 })
})
