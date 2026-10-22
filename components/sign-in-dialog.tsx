'use client'

import { useEffect, useRef, useState } from 'react'
import { fastClick } from '../lib/fast-click'
import { focusPrompt } from '../lib/prompt-focus'
import { Button, buttonVariants } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'

export default function SignInDialog({ open, reauthorize, onOpenChange, onSignIn, error }: {
  error: string
  open: boolean
  reauthorize: boolean
  onOpenChange: (open: boolean) => void
  onSignIn: () => boolean
}) {
  const href = '/'
  // Pending from the press until the page leaves; back navigation restores the page
  // from the back/forward cache, so pageshow clears it.
  const [redirecting, setRedirecting] = useState(false)
  // The spinner joins the label inside the button's current box, so nothing moves.
  const link = useRef<HTMLAnchorElement>(null)
  const [lockedWidth, setLockedWidth] = useState<number | undefined>()
  useEffect(() => {
    const clear = () => { setRedirecting(false); setLockedWidth(undefined) }
    if (!open) clear()
    const reset = (event: PageTransitionEvent) => { if (event.persisted) clear() }
    window.addEventListener('pageshow', reset)
    return () => window.removeEventListener('pageshow', reset)
  }, [open])
  const signIn = () => {
    if (redirecting || !onSignIn()) return false
    setLockedWidth(link.current?.offsetWidth)
    setRedirecting(true)
    return true
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Focus the dialog itself: a keyboard-opened dialog otherwise lands a focus ring on a button. */}
      <DialogContent
        onOpenAutoFocus={(event) => { event.preventDefault(); (event.currentTarget as HTMLElement).focus() }}
        onCloseAutoFocus={(event) => { event.preventDefault(); focusPrompt() }}>
        <DialogTitle className="text-lg font-medium">Reconnect through Tailscale</DialogTitle>
        <DialogDescription className="mt-2 text-sm text-muted-foreground">
          Connect to your tailnet, then reload fx0. Your draft is kept.
        </DialogDescription>
        {error && <p role="alert" className="mt-3 text-sm text-error">{error}</p>}
        <div className="mt-5 flex flex-wrap gap-2">
          <a
            ref={link}
            href={href}
            onPointerDown={(event) => {
              if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return
              event.preventDefault()
              if (signIn()) window.location.assign(href)
            }}
            onClick={(event) => {
              // Pointer presses navigated on pointer-down; keyboard and modified clicks land here.
              const modified = event.ctrlKey || event.metaKey || event.shiftKey
              if (event.detail !== 0 && !modified) event.preventDefault()
              else if (modified ? !onSignIn() : !signIn()) event.preventDefault()
            }}
            aria-busy={redirecting || undefined}
            aria-disabled={redirecting || undefined}
            style={{ width: lockedWidth }}
            className={buttonVariants({ className: redirecting ? 'pointer-events-none gap-1.5' : undefined })}
          >
            {redirecting && (
              <svg viewBox="0 0 16 16" className="size-3 animate-spin motion-reduce:animate-none" fill="none" aria-hidden="true">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2" />
                <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            )}
            Reload fx0
          </a>
          <Button variant="outline" {...fastClick(() => onOpenChange(false))}>Cancel</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
