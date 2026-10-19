import { NextResponse } from 'next/server'

export async function GET() {
  return NextResponse.json({ error: 'Sign in required' }, { status: 401, headers: { 'Cache-Control': 'no-store' } })
}
