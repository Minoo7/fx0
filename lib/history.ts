// Durable record of what each chat generated. Redis stays the live journal; this is
// written once per finished turn and once per published design, never per token.
// @ts-expect-error Node strip-types tests require the source extension.
import { validSessionId, withAccountDatabase, type AccountQuery } from './accounts.ts'

export interface TurnRecord {
  sessionId: string
  turnId: number
  prompt: string
  response: string
  model: string
  effort: string | null
  fast: boolean
  status: 'done' | 'error'
  stopReason: string | null
  billingTeamId: string | null
  inputTokens: number | null
  outputTokens: number | null
  startedAt: number
}

const TITLE_LENGTH = 40

function validRevision(revision: unknown): revision is number {
  return Number.isSafeInteger(revision) && (revision as number) > 0
}

function tokenCount(value: number | null): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value : null
}

export function createHistoryStore(query: AccountQuery) {
  return {
    // The chat row must exist (it is reserved before the first prompt); a turn for an
    // unowned or deleted chat inserts nothing. Neither writer touches updated_at:
    // the sidebar orders chats by their last prompt, which touchOwnedSession records.
    async recordTurn(turn: TurnRecord): Promise<boolean> {
      if (!validSessionId(turn.sessionId) || !validRevision(turn.turnId)) return false
      const rows = await query(`WITH chat AS (
        UPDATE fx0_chat_ownership SET title = COALESCE(title, $13)
        WHERE session_id = $1 RETURNING session_id
      )
      INSERT INTO fx0_turns (session_id, turn_id, prompt, response, model, effort, fast, status,
        stop_reason, input_tokens, output_tokens, started_at, billing_team_id)
      SELECT session_id, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, to_timestamp($12 / 1000.0), $14 FROM chat
      ON CONFLICT (session_id, turn_id) DO NOTHING RETURNING turn_id`,
      [turn.sessionId, turn.turnId, turn.prompt, turn.response, turn.model, turn.effort || null, turn.fast,
        turn.status, turn.stopReason, tokenCount(turn.inputTokens), tokenCount(turn.outputTokens), turn.startedAt,
        // Code points, not UTF-16 units: a cut emoji half is not valid text.
        [...turn.prompt].slice(0, TITLE_LENGTH).join(''), turn.billingTeamId?.startsWith('team_') ? turn.billingTeamId : null])
      return rows.length > 0
    },
    async recordGeneration(sessionId: string, revision: number, turnId: number | null, html: string): Promise<boolean> {
      if (!validSessionId(sessionId) || !validRevision(revision)) return false
      const rows = await query(`WITH chat AS (
        SELECT session_id FROM fx0_chat_ownership WHERE session_id = $1 FOR KEY SHARE
      )
      INSERT INTO fx0_generations (session_id, revision, turn_id, html, bytes)
      SELECT session_id, $2, $3, $4, $5 FROM chat
      ON CONFLICT (session_id, revision) DO NOTHING RETURNING revision`,
      [sessionId, revision, validRevision(turnId) ? turnId : null, html, Buffer.byteLength(html, 'utf8')])
      return rows.length > 0
    },
    // Reads join ownership again, so a caller that skipped the route check still sees nothing.
    async readGeneration(userId: string, sessionId: string, revision: number): Promise<string | null> {
      if (!validSessionId(sessionId) || !validRevision(revision)) return null
      const [row] = await query(`SELECT g.html FROM fx0_generations g
        JOIN fx0_chat_ownership c ON c.session_id = g.session_id
        WHERE g.session_id = $1 AND g.revision = $2 AND c.user_id = $3`, [sessionId, revision, userId])
      return typeof row?.html === 'string' ? row.html : null
    },
  }
}

// History is written from the work a turn's end leaves in Redis, which stays until
// the write succeeds, so a later follower retries a failed one. The inserts are
// idempotent (ON CONFLICT DO NOTHING), so retrying is safe; each attempt is bounded
// so a stalled database cannot hold the worker.
const WRITE_ATTEMPTS = 3
const WRITE_TIMEOUT_MS = 5_000

async function durably<T>(work: (query: AccountQuery) => Promise<T>): Promise<T> {
  let failure: unknown
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 250 * 4 ** (attempt - 1)))
    try {
      return await withAccountDatabase(work, { timeoutMs: WRITE_TIMEOUT_MS })
    } catch (error) {
      failure = error
    }
  }
  throw failure
}

export async function recordTurn(turn: TurnRecord): Promise<boolean> {
  return durably((query) => createHistoryStore(query).recordTurn(turn))
}

export async function recordGeneration(sessionId: string, revision: number, turnId: number | null, html: string): Promise<boolean> {
  return durably((query) => createHistoryStore(query).recordGeneration(sessionId, revision, turnId, html))
}

export async function readGeneration(userId: string, sessionId: string, revision: number): Promise<string | null> {
  return withAccountDatabase((query) => createHistoryStore(query).readGeneration(userId, sessionId, revision))
}
