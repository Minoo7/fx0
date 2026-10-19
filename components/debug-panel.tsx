'use client'

import { useEffect, useState } from 'react'
import { AuthRouteError, fetchUi } from './auth-ui'
import { Button } from './ui/button'
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs'

export interface LocalLogEntry {
  at: number
  type: string
  summary: string
  instance?: string
}

interface JournalEntry {
  seq: number | null
  at: number | null
  type: string
  turnId: number | null
  instance: string | null
  detail: string
}

interface ServerState {
  instance: string
  libfxSessionId: string | null
  busy: boolean
  currentTurnId: number | null
  lastActivity: string
  following: boolean
  seq: number
  projectedCursor: number
  journal: JournalEntry[]
}

function clockTime(at: number | null): string {
  return at == null ? '' : new Date(at).toISOString().slice(11, 23)
}

export default function DebugPanel({
  open,
  sessionId,
  localLog,
  serverInstance,
  onOpenChange,
}: {
  open: boolean
  sessionId: string
  localLog: LocalLogEntry[]
  serverInstance: string | null
  onOpenChange: (open: boolean) => void
}) {
  const [server, setServer] = useState<ServerState | null>(null)
  const [serverError, setServerError] = useState('')
  const [, forceRender] = useState(0)

  useEffect(() => {
    if (!open) return
    const timer = window.setInterval(() => forceRender((value) => value + 1), 2000)
    return () => window.clearInterval(timer)
  }, [open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    let timer: number | undefined
    let controller: AbortController | null = null

    async function poll() {
      controller = new AbortController()
      try {
        const response = await fetchUi(`/api/debug?session=${encodeURIComponent(sessionId)}`, {
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`Debug request failed with ${response.status}`)
        const next = (await response.json()) as ServerState
        if (!cancelled) {
          setServer(next)
          setServerError('')
        }
      } catch (error) {
        if (error instanceof AuthRouteError) {
          cancelled = true
          return
        }
        if (!cancelled && (error as Error).name !== 'AbortError') {
          setServerError('Unable to refresh server state. Retrying…')
        }
      } finally {
        if (!cancelled) timer = window.setTimeout(poll, 3000)
      }
    }

    void poll()
    return () => {
      cancelled = true
      controller?.abort()
      if (timer) window.clearTimeout(timer)
    }
  }, [open, sessionId])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent id="debug-panel" className="p-0" aria-describedby="debug-description">
        <SheetHeader className="border-b px-4 py-3">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <SheetTitle>Session diagnostics</SheetTitle>
              <SheetDescription id="debug-description" className="mt-0.5 text-xs">
                Events this tab received live, and this chat&apos;s durable journal in Redis.
              </SheetDescription>
            </div>
            <SheetClose asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close diagnostics">
                <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                  <path d="m3 3 10 10M13 3 3 13" />
                </svg>
              </Button>
            </SheetClose>
          </div>
        </SheetHeader>

        <div className="border-b bg-muted/35 px-4 py-3 font-mono text-xs leading-5 text-muted-foreground">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            <dt>Stream server</dt>
            <dd className="min-w-0 truncate text-foreground">{serverInstance ?? 'Waiting…'}</dd>
            <dt>Panel server</dt>
            <dd className="min-w-0 truncate text-foreground">{server?.instance ?? 'Waiting…'}</dd>
            <dt>libfx session</dt>
            <dd className="min-w-0 truncate text-foreground">{server?.libfxSessionId ?? 'None'}</dd>
            <dt>Turn</dt>
            <dd className="text-foreground tabular-nums">{server?.currentTurnId ?? '—'}</dd>
            <dt>Journal</dt>
            <dd className="text-foreground tabular-nums">
              {server ? `seq ${server.seq} · libfx line ${server.projectedCursor}` : 'Waiting…'}
            </dd>
          </dl>
          {serverError && <p role="status" className="mt-2 text-xs text-error">{serverError}</p>}
        </div>

        <Tabs defaultValue="browser" className="flex min-h-0 flex-1 flex-col">
          <div className="px-3 py-2">
            <TabsList className="w-full">
              <TabsTrigger value="browser" className="flex-1">Browser events</TabsTrigger>
              <TabsTrigger value="journal" className="flex-1">Durable journal</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="browser" className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
            {localLog.length === 0 ? (
              <p className="px-2 py-8 text-center text-sm text-muted-foreground">No browser events yet.</p>
            ) : (
              <div className="divide-y font-mono text-xs">
                {[...localLog].reverse().map((entry, index) => (
                  <div key={`${entry.at}-${index}`} className="py-2">
                    <div className="flex items-baseline gap-2">
                      <span className="shrink-0 text-muted-foreground tabular-nums">{clockTime(entry.at)}</span>
                      <span className="min-w-0 break-all text-foreground-secondary">{entry.type}</span>
                    </div>
                    {entry.summary && <p className="mt-0.5 break-all text-foreground/80">{entry.summary}</p>}
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="journal" className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
            {!server?.journal.length ? (
              <p className="px-2 py-8 text-center text-sm text-muted-foreground">No journal entries yet.</p>
            ) : (
              <div className="divide-y font-mono text-xs">
                {[...server.journal].reverse().map((entry, index) => {
                  const meta = [entry.turnId != null ? `turn ${entry.turnId}` : null, entry.instance, entry.detail || null]
                    .filter(Boolean)
                    .join(' · ')
                  return (
                    <div key={`${entry.seq ?? 'x'}-${index}`} className="py-2">
                      <div className="flex items-baseline gap-2">
                        <span className="shrink-0 text-muted-foreground tabular-nums">#{entry.seq ?? '?'}</span>
                        <span className="min-w-0 break-all text-foreground-secondary">{entry.type}</span>
                        <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">{clockTime(entry.at)}</span>
                      </div>
                      {meta && <p className="mt-0.5 break-all text-foreground/80">{meta}</p>}
                    </div>
                  )
                })}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}
