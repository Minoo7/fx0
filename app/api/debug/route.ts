import { debugState } from '../../../lib/agent'
import type { StreamItem } from '../../../lib/events'
import { withSessionRoute } from '../../../lib/route-auth'

export const maxDuration = 60

function journalDetail(event: StreamItem): string {
  if (event.type === 'artifact') return `version ${event.artifactRevision ?? '?'}`
  if (event.name) return event.name
  return (event.text ?? event.delta ?? event.stopReason ?? '').slice(0, 90)
}

export const GET = withSessionRoute(async (_request, { host }) => {
  const state = await debugState(host)
  // Deliberate allowlist: runtime/transport additions and provider error logs
  // must never accidentally expose credentials or private transport context.
  return Response.json({
    instance: state.instance, session: host.id, libfxSessionId: state.libfxSessionId,
    busy: state.busy, currentTurnId: state.currentTurnId,
    lastActivity: state.lastActivity, following: state.following,
    pendingQuestion: state.pendingQuestion, projectedCursor: state.projectedCursor,
    artifactRevision: state.artifactRevision, seq: state.seq,
    journal: state.journal.map((event) => ({
      seq: event.seq ?? null, at: event.at ?? null, type: event.type,
      turnId: event.turnId ?? null, instance: event.instance ?? null, detail: journalDetail(event),
    })),
  })
})
