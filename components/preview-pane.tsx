'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { EMPTY_DRAFT_DOCUMENT, patchDraftDocument } from '../lib/draft-preview'
import { HowItWorksPanel } from './how-it-works'

export type PreviewSource = { kind: 'design'; sessionId: string; revision: number }

export default function PreviewPane({
  source,
  viewing,
  draft = null,
  intro,
  onClose,
}: {
  source: PreviewSource
  // A past revision opened from the transcript's "View" link, never the latest; null is the latest.
  viewing: number | null
  // The design as the model writes it; shown until the real publish arrives.
  draft?: string | null
  // Only an empty chat explains fx0; a chat waiting on its first design stays blank.
  intro: boolean
  onClose: () => void
}) {
  const session = encodeURIComponent(source.sessionId)
  const previewUrl = source.revision > 0
    ? viewing != null
      ? `/api/artifact-frame?session=${session}&revision=${viewing}`
      : `/api/artifact-frame?session=${session}&v=${source.revision}`
    : null

  // A new revision, or another chat's design, loads in a slot underneath and comes to
  // the front once it has loaded, so the screen never shows a frame mid-load. The
  // slots never move in the DOM (moving an iframe reloads it); only which one is in
  // front changes. The draft stays on top until the front slot shows the latest
  // revision.
  const [slots, setSlots] = useState<[string | null, string | null]>([previewUrl, null])
  const [front, setFront] = useState<number | null>(previewUrl ? 0 : null)
  const wanted = useRef(previewUrl)
  wanted.current = previewUrl
  const slotUrls = useRef(slots)
  slotUrls.current = slots
  const fallback = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Only a slot holding the revision asked for now may come to the front; a late
  // paint or fallback from a revision already left behind is ignored.
  const bringToFront = (index: number) => {
    if (slotUrls.current[index] !== wanted.current) return
    if (fallback.current) clearTimeout(fallback.current)
    setFront(index)
  }
  useEffect(() => {
    if (!previewUrl) {
      setSlots([null, null])
      setFront(null)
      return
    }
    // Returning to a design still loaded in a slot (the chat just left, or the latest
    // after viewing an older revision) shows it at once; it has already painted.
    const loaded = slots.indexOf(previewUrl)
    if (loaded >= 0) {
      bringToFront(loaded)
      return
    }
    const target = front == null ? 0 : 1 - front
    setSlots((current) => (target === 0 ? [previewUrl, current[1]] : [current[0], previewUrl]))
  }, [previewUrl]) // eslint-disable-line react-hooks/exhaustive-deps
  // A slot comes to the front once its design reports it has painted. The design
  // renders in a nested frame in another process, so the slot's own load event
  // fires before that and swapping then showed the wrapper's white page. Documents
  // that never report (a missing revision) swap a while after loading.
  const frames = useRef<(HTMLIFrameElement | null)[]>([null, null])
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.data?.type !== 'fx0-artifact-painted') return
      const index = frames.current.findIndex((frame) => frame?.contentWindow === event.source)
      if (index >= 0) bringToFront(index)
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      if (fallback.current) clearTimeout(fallback.current)
    }
  }, [])
  const caughtUp = !previewUrl || (front != null && slots[front] === previewUrl)
  const [heldDraft, setHeldDraft] = useState<string | null>(null)
  const liveDraft = draft && renderable(draft) ? draft : null
  useEffect(() => {
    if (liveDraft) setHeldDraft(liveDraft)
    else if (!draft && caughtUp) setHeldDraft(null)
  }, [liveDraft, draft, caughtUp])
  const draftLayer = liveDraft ?? heldDraft
  const shownUrl = front != null ? slots[front] : null

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !window.matchMedia('(max-width: 1023px)').matches) return
      event.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <section
      id="preview-pane"
      aria-label="preview"
      className="order-1 flex min-h-0 min-w-0 flex-1 flex-col bg-background overscroll-contain lg:order-none lg:border-l lg:border-border"
    >
      {draftLayer || shownUrl || slots[0] || slots[1] ? (
        <div className="relative min-h-0 flex-1">
          {slots.map((url, index) => url && (
            <iframe
              key={index}
              ref={(element) => { frames.current[index] = element }}
              src={url}
              referrerPolicy="no-referrer"
              title={index === front ? 'Design artifact preview' : undefined}
              aria-hidden={index !== front || undefined}
              onLoad={() => {
                if (index === front) return
                if (fallback.current) clearTimeout(fallback.current)
                fallback.current = setTimeout(() => bringToFront(index), 1500)
              }}
              className={`absolute inset-0 h-full w-full bg-background ${frameLayer(index === front, front != null)}`}
            />
          ))}
          {draftLayer && (
            <div className="absolute inset-0 z-20 flex">
              <DraftPreview html={draftLayer} />
            </div>
          )}
        </div>
      ) : intro ? (
        // A chat loading from its URL (html.chat-url) is not empty, so it stays blank too.
        <div className="min-h-0 flex-1 overflow-y-auto [html.chat-url_&]:hidden">
          <div className="flex min-h-full items-center justify-center px-6 py-10">
            <div className="w-full max-w-sm">
              <HowItWorksPanel />
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1" />
      )}
    </section>
  )
}

// The partial document renders with no scripts and a CSP that blocks every external
// load. It is a picture of the design in progress; the published version, with its
// scripts, replaces it. Same origin keeps it in this process: an opaque-origin frame
// paints in another process after its load event, so the swap showed white.

// A cut that ends before any body content renders as a blank white page, so the
// draft only takes over the screen once the body has started.
function renderable(html: string): boolean {
  const body = /<body[^>]*>/i.exec(html)
  return body != null && /<[a-z]/i.test(html.slice(body.index + body[0].length))
}

// The front frame is on top. A loading frame sits underneath it, still painted; with
// nothing in front yet it is transparent, so the layer below shows instead of white.
function frameLayer(isFront: boolean, hasFront: boolean): string {
  return isFront ? 'z-10' : hasFront ? 'pointer-events-none z-0' : 'pointer-events-none z-0 opacity-0'
}

// The provisional picture keeps one scriptless document. Published interactive
// artifacts still use the isolated, double-buffered slots above.
function DraftPreview({ html }: { html: string }) {
  const frame = useRef<HTMLIFrameElement | null>(null)
  const ready = useRef(false)
  const [painted, setPainted] = useState(false)
  const latest = useRef(html)
  latest.current = html
  const lastPush = useRef(0)
  const pushed = useRef('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const schedule = useCallback(() => {
    if (!ready.current || timer.current || latest.current === pushed.current) return
    timer.current = setTimeout(() => {
      timer.current = null
      const doc = frame.current?.contentDocument
      if (!doc || !ready.current) return
      patchDraftDocument(doc, latest.current)
      pushed.current = latest.current
      lastPush.current = Date.now()
      setPainted(true)
    }, Math.max(0, 150 - (Date.now() - lastPush.current)))
  }, [])
  useEffect(() => {
    schedule()
    return () => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
    }
  }, [html, schedule])

  return (
    <div className="relative min-h-0 flex-1">
      <iframe
        ref={frame}
        srcDoc={EMPTY_DRAFT_DOCUMENT}
        sandbox="allow-same-origin"
        referrerPolicy="no-referrer"
        title="Design preview while generating"
        onLoad={() => {
          ready.current = true
          schedule()
        }}
        className={`absolute inset-0 h-full w-full bg-background ${painted ? '' : 'opacity-0'}`}
      />
    </div>
  )
}
