'use client'

import { fastClick } from '../lib/fast-click'
import { Button } from './ui/button'

export default function NewChat({
  compact = false,
  onNew,
}: {
  compact?: boolean
  onNew: () => void
}) {
  return (
    <Button
      variant="ghost"
      size={compact ? 'icon-sm' : 'sm'}
      aria-label="new HTML design"
      {...fastClick(onNew)}
      className={compact ? '' : 'h-7 w-full justify-start gap-2 px-3 text-[13px] text-foreground-secondary hover:text-foreground focus-visible:ring-offset-sidebar'}
    >
      <svg width={compact ? 14 : 12} height={compact ? 14 : 12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <path d="M8 2v12M2 8h12" />
      </svg>
      {!compact && 'new design'}
    </Button>
  )
}
