'use client'

import { useEffect, useState } from 'react'
import { loadCached, readCached } from './cached-fetch'

// Slug-free deep link: Vercel resolves [team] after login. Used until the team
// slug is known, and when all we hold is a raw team_ id, which would 404 in a path.
const FALLBACK_URL = 'https://vercel.com/d?to=' + encodeURIComponent('/[team]/~/ai-gateway')

export interface Balance {
  balance: number | null
  flexible: boolean
}

export function buyCreditsUrl(teamSlug: string | null): string {
  return teamSlug && !teamSlug.startsWith('team_')
    ? `https://vercel.com/${encodeURIComponent(teamSlug)}/~/ai-gateway`
    : FALLBACK_URL
}

// AI Gateway balance of the billing team, shown in the account menu. The last
// known value paints at once; it revalidates when older than 30s, on mount and
// when the tab regains focus (back from the dashboard). Null hides the amount.
export function useCredits(userId: string | null, team: string | null): Balance | null {
  const [state, setState] = useState<Balance | null>(null)
  const key = userId ? `fx0:cache:credits:${userId}:${team ?? ''}` : null

  useEffect(() => {
    if (!key) return
    setState(readCached<Balance>(key)?.value ?? null)
    let live = true
    const load = () => void loadCached<Balance>(key, '/api/credits', 30_000).then((next) => {
      if (live && next) setState(next)
    })
    load()
    window.addEventListener('focus', load)
    return () => {
      live = false
      window.removeEventListener('focus', load)
    }
  }, [key])

  return state
}
