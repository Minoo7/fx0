'use client'

import { useEffect, useRef, useState } from 'react'
import { fastClick } from '../lib/fast-click'
import { Button, buttonVariants } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'

// A click already under way when the dialog appears must not land on Open link.
const ARM_MS = 500

// A design asked to open `url`. Only a real click on this dialog's link opens it,
// in a new tab with no opener or referrer; the design cannot reach this dialog.
export default function DesignLinkDialog({ url, onClose }: { url: string | null; onClose: () => void }) {
  const [armed, setArmed] = useState(false)
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    setArmed(false)
    if (!url) return
    const timer = setTimeout(() => setArmed(true), ARM_MS)
    return () => clearTimeout(timer)
  }, [url])
  const parsed = url ? new URL(url) : null
  const origin = parsed ? `${parsed.protocol}//${parsed.host}` : ''
  return (
    <Dialog open={url != null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        className="max-w-md"
        // Cancel takes focus, so Enter never opens the link by default.
        onOpenAutoFocus={(event) => { event.preventDefault(); cancel.current?.focus() }}
      >
        <DialogTitle className="text-lg font-medium">Open this link?</DialogTitle>
        <DialogDescription className="mt-2 text-sm text-muted-foreground">
          The design wants to open this page in a new tab. Open it only if you expect it.
        </DialogDescription>
        {url && (
          <p className="mt-4 max-h-40 overflow-y-auto break-all bg-secondary px-3 py-2 font-mono text-xs text-foreground-secondary">
            <span className="font-semibold text-foreground">{origin}</span>
            {url.slice(origin.length)}
          </p>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          <a
            href={url ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
            aria-disabled={!armed || undefined}
            onClick={(event) => {
              if (!armed) {
                event.preventDefault()
                return
              }
              // Close after the browser follows the link: a link removed during its
              // own click does not navigate.
              setTimeout(onClose, 0)
            }}
            className={buttonVariants({ className: armed ? undefined : 'pointer-events-none opacity-60' })}
          >
            Open link
          </a>
          <Button ref={cancel} variant="outline" {...fastClick(onClose)}>Cancel</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
