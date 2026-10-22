import { withUserRoute } from '@/lib/route-auth'

export const GET = withUserRoute(async (_request, { user }) => Response.json({ user }))
