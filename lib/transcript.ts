// A read checkpoint of the append-only journal, never an alternative authority.
// @ts-expect-error Node strip-types tests require the source extension.
import { replayEvents, type ReplayedChatState } from '../components/chat-state.ts'
import type { SessionInfo, SessionView, StreamItem } from './events'

export interface TranscriptSnapshot extends Omit<ReplayedChatState, 'startedTurns'> {
  version: 1
  startedTurns: number[]
}

export interface SessionSnapshot {
  transcript: TranscriptSnapshot
  summary: SessionInfo | null
}

export function transcriptState(snapshot: TranscriptSnapshot): ReplayedChatState {
  const { version: _version, startedTurns, ...state } = snapshot
  return { ...state, startedTurns: new Set(startedTurns) }
}

export function compactTranscript(events: StreamItem[], view: SessionView, previous?: TranscriptSnapshot | null): TranscriptSnapshot {
  const state = replayEvents(events, view, previous ? transcriptState(previous) : undefined)
  return { ...state, version: 1, startedTurns: [...state.startedTurns] }
}

export function createTranscriptReader(boundary: {
  read(id: string): Promise<{ previous: TranscriptSnapshot | null; events: StreamItem[]; view: SessionView; summary: SessionInfo | null }>
  publish(id: string, snapshot: TranscriptSnapshot): Promise<void>
}) {
  return async (id: string, deferCheckpoint?: (publish: () => Promise<void>) => void): Promise<SessionSnapshot> => {
    const { previous, events, view, summary } = await boundary.read(id)
    const transcript = compactTranscript(events, view, previous)
    if (!previous || transcript.lastSeq > previous.lastSeq) {
      // Checkpoints are expendable: a write failure must not hide a readable chat.
      const publish = () => boundary.publish(id, transcript).catch(() => {})
      if (deferCheckpoint) deferCheckpoint(publish)
      else await publish()
    }
    return { transcript, summary }
  }
}
