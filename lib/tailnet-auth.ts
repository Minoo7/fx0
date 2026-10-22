import { createHash, timingSafeEqual } from 'node:crypto'
import { headers } from 'next/headers'
import { AuthError, type AccountUser } from './accounts'

export interface TailnetSession {
  userId: string
  email: string
  name?: string
  picture?: string
}

export function tailnetSession(incoming: Headers): TailnetSession {
  const expected = process.env.FX0_PROXY_SECRET
  const received = incoming.get('x-fx0-proxy-secret') ?? ''
  if (!expected || expected.length < 32 || Buffer.byteLength(received) !== Buffer.byteLength(expected) ||
    !timingSafeEqual(Buffer.from(received), Buffer.from(expected))) throw new AuthError(403, 'Tailnet access required')
  const email = incoming.get('tailscale-user-login')
  if (!email || email.length > 256) throw new AuthError(403, 'Tailscale user identity required')
  return {
    userId: `tailscale:${createHash('sha256').update(email).digest('hex')}`,
    email,
    name: incoming.get('tailscale-user-name') || email,
    picture: incoming.get('tailscale-user-profile-pic') || undefined,
  }
}

export async function requireUserSession(): Promise<TailnetSession> {
  return tailnetSession(await headers())
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('origin')
  const expected = process.env.APP_URL ? new URL(process.env.APP_URL).origin : `https://${request.headers.get('host')}`
  if (!origin || origin !== expected) throw new AuthError(403, 'Cross-origin request denied')
}

export function publicUser(session: TailnetSession): AccountUser {
  return { id: session.userId, name: session.name || session.email, email: session.email, picture: session.picture || null }
}
