import { NextResponse } from 'next/server'
import { publicUser } from '@/lib/auth'
import { isAuthenticatedSession } from '@/lib/secure-session'
import { withRequestSession } from '@/lib/request-session'

export const GET = withRequestSession(async (_request, session) => {
  return NextResponse.json({ user: isAuthenticatedSession(session) ? publicUser(session) : null }, {
    headers: { 'Cache-Control': 'no-store' },
  })
})
