'use client'

import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Button } from './ui/button'
export interface AccountUser { id: string; name: string; email: string | null; picture: string | null; guest?: true }

export default function AccountMenu({ user, sidebar = false, side = sidebar ? 'top' : 'bottom' }: {
  user: AccountUser | null | undefined; sidebar?: boolean; side?: 'top' | 'bottom'
}) {
  return <Popover>
    <PopoverTrigger asChild><Button variant="ghost" size="sm" aria-label={`Account: ${user?.name ?? 'loading'}`}>
      {user?.name ?? 'loading…'}
    </Button></PopoverTrigger>
    <PopoverContent side={side} align="start" className="w-60 p-3 text-sm">
      <p className="truncate font-medium">{user?.name}</p>
      <p className="mt-1 text-xs text-foreground-secondary">Connected through your tailnet</p>
      <a className="mt-3 block underline" href="/providers">Model providers</a>
    </PopoverContent>
  </Popover>
}
