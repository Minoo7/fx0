import { NextResponse, type NextRequest } from 'next/server'
import { tailnetSession } from './lib/tailnet-auth'

export function proxy(request: NextRequest) {
  try {
    tailnetSession(request.headers)
    const response = NextResponse.next()
    response.cookies.set('fx0-signed-in', '1', { path: '/', sameSite: 'lax', secure: true })
    return response
  } catch {
    return new NextResponse('Tailnet access required', { status: 403, headers: { 'cache-control': 'no-store' } })
  }
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] }
