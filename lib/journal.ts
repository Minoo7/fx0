import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { Redis } from '@upstash/redis'
// @ts-expect-error Node's strip-types integration test requires the source extension.
import { validateDesignArtifactHtml } from './design-artifact.ts'
// @ts-expect-error Node's strip-types integration test requires the source extension.
import { type DesignMdInput } from './design-md.ts'
// @ts-expect-error Node's strip-types integration test requires the source extension.
import { type SessionInfo, type SessionView, type StreamItem } from './events.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { createTranscriptReader, type TranscriptSnapshot } from './transcript.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { AuthError } from './accounts.ts'

const PREFIX = process.env.FX0_REDIS_PREFIX?.trim() || 'fx0:v1'

let client: Redis | null = null

export function redis(): Redis {
  if (!client) {
    const url = process.env.KV_REST_API_URL
    const token = process.env.KV_REST_API_TOKEN
    if (!url || !token) throw new Error('Redis journal is not configured (KV_REST_API_URL/KV_REST_API_TOKEN)')
    client = new Redis({ url, token })
  }
  return client
}

// Events committed by this process, announced the moment Redis confirms them. A
// stream in the same process (a prompt's own response, where its worker also runs)
// delivers them without waiting for its next journal poll; polling still covers
// events written by other instances, and seq keeps delivery exactly-once.
const g = globalThis as unknown as { __fx0LocalEvents?: EventEmitter }
export const localEvents = g.__fx0LocalEvents ??= new EventEmitter().setMaxListeners(0)

// Ephemeral, display-only events (a design being written, for instance) that are
// never journaled: only streams in this process see them, and a reload does not.
export function emitLive(sessionId: string, item: StreamItem): void {
  localEvents.emit(`${sessionId}:live`, item)
}

function announce<T extends StreamItem | null | undefined>(sessionId: string, item: T): T {
  if (item && typeof item.seq === 'number') localEvents.emit(sessionId, item)
  return item
}

function key(sessionId: string, part: string): string {
  return `${PREFIX}:session:${sessionId}:${part}`
}

export function prefixed(part: string): string {
  return `${PREFIX}:${part}`
}

const LEASE_MS = 180_000

export class SessionCleanupError extends Error {
  constructor() {
    super('chat was deleted or is being deleted')
    this.name = 'SessionCleanupError'
  }
}

export interface StoredSession {
  id: string
  createdAt: number
  // When the chat last received a prompt. Only submitPrompt sets it, so the
  // sidebar keeps chats in the order their prompts arrived, not their replies.
  lastActivity: number
  title: string | null
  preferredModel: string | null
  preferredEffort: string | null
  preferredFast: boolean | null
  // Set by the prompt that created the chat; the text lives in its own key.
  designMd: DesignMdMeta | null
  // The libfx session that holds this chat's conversation, once its first prompt ran.
  libfxSessionId: string | null
  // The turn that published the current design, so its end records that version.
  artifactTurn: number | null
  trialChat: boolean
}

export interface DesignMdMeta {
  name: string
  source: string
  sha: string
  bytes: number
}

export interface DurablePromptImage {
  type: 'image'
  data: string
  mimeType: string
}

export interface DurablePrompt {
  id: number
  author: string
  text: string
  clientId?: string
  images?: DurablePromptImage[]
  previews?: string[]
}

// The turn libfx is running, as the projector last saw it: the message that
// started it, when, and the team billed. It expires on its own, so a lost
// turn_end can't leave a chat busy forever.
export interface ActiveTurn {
  sponsored?: true
  id: number
  startedAt: number
  billingTeamId: string | null
  // The prompt text for the turn's history row, and the transcript position its
  // response starts at.
  prompt: string
  startSeq: number
  // The settings the turn started with. A settings change during the turn
  // applies from the next one. Absent on turns started before this was recorded.
  settings?: TurnSettings
}

export interface TurnSettings { model: string; effort: string; fast: boolean }

function parseJson<T>(value: unknown): T {
  if (typeof value === 'string') return JSON.parse(value) as T
  return value as T
}

// Creates the state hash on first write. Returns whether the hash already existed.
const INIT_STATE = `
local function init_state(state, id, now)
  local exists = redis.call('EXISTS', state)
  redis.call('HSETNX', state, 'id', id)
  redis.call('HSETNX', state, 'createdAt', now)
  redis.call('HSETNX', state, 'artifactRevision', 0)
  return exists
end
`

const SUBMIT_PROMPT = INIT_STATE + `
if redis.call('EXISTS', KEYS[4]) == 1 then return false end
local trial = redis.call('HGET', KEYS[5], 'trialChat')
if not trial then
  local previous = tonumber(redis.call('GET', KEYS[1]) or '0')
  trial = previous == 0 and ARGV[7] == '1' and '1' or '0'
end
-- A paid conversation cannot acquire sponsorship behind an already-admitted
-- steer. Trial eligibility is fixed before its first SDK submission.
if ARGV[7] == '1' and trial ~= '1' then return cjson.encode({error = 'not_trial_chat'}) end
local now = tonumber(ARGV[1])
local id = redis.call('INCR', KEYS[1])
local event = cjson.decode(ARGV[2])
event.id = id
local seq = redis.call('INCR', KEYS[2])
event.seq = seq
local created = init_state(KEYS[5], ARGV[3], now) == 0
if created and ARGV[5] ~= '' then
  local design = cjson.decode(ARGV[5])
  redis.call('HSET', KEYS[5], 'designMd', ARGV[5])
  redis.call('SET', KEYS[6], ARGV[6])
  event.designMd = { name = design.name, source = design.source }
end
-- Idle: no turn is running and the latest earlier message's turn has ended, so
-- this message starts a turn of its own. A settings notice, a status with no
-- turn, doesn't count. Read before this message is appended.
local idle = redis.call('EXISTS', KEYS[7]) == 0
if idle then
  local recent = redis.call('LRANGE', KEYS[3], -10, -1)
  for i = #recent, 1, -1 do
    local item = cjson.decode(recent[i])
    if not (item.type == 'status' and item.turnId == nil) then
      idle = item.type == 'done' or (item.type == 'error' and item.turnId ~= nil)
      break
    end
  end
end
redis.call('RPUSH', KEYS[3], cjson.encode(event))
if created and ARGV[4] ~= '' then
  for field, value in pairs(cjson.decode(ARGV[4])) do redis.call('HSET', KEYS[5], field, value) end
end
redis.call('HSET', KEYS[5], 'lastActivity', now)
redis.call('HSET', KEYS[5], 'trialChat', trial)
if event.text and event.text ~= '' then
  redis.call('HSETNX', KEYS[5], 'title', string.sub(event.text, 1, 40))
end
return cjson.encode({id = id, event = event, idle = idle, trialChat = trial == '1'})
`

export type InitialGeneration = Partial<Pick<StoredSession, 'preferredModel' | 'preferredEffort' | 'preferredFast'>> & {
  designMd?: DesignMdInput | null
}

// `initial` applies only when this prompt creates the chat, in the same atomic
// script, so a new chat needs no separate settings write before its first prompt.
// `idle` says whether the chat had no turn running or waiting when it arrived.
export async function submitPrompt(
  sessionId: string,
  prompt: Omit<DurablePrompt, 'id'>,
  initial?: InitialGeneration,
  sponsored = false,
): Promise<{ id: number; event: StreamItem; idle: boolean; trialChat: boolean }> {
  const now = Date.now()
  const initialFields: Record<string, string> = {}
  for (const name of ['preferredModel', 'preferredEffort', 'preferredFast'] as const) {
    const value = initial?.[name]
    if (value != null && value !== '') initialFields[name] = String(value)
  }
  const design = initial?.designMd
  const designMeta: DesignMdMeta | null = design
    ? {
        name: design.name,
        source: design.source,
        sha: createHash('sha256').update(design.text).digest('hex'),
        bytes: Buffer.byteLength(design.text),
      }
    : null
  const raw = await redis().eval<unknown[], unknown>(
    SUBMIT_PROMPT,
    [
      key(sessionId, 'message-seq'), key(sessionId, 'event-seq'), key(sessionId, 'events'),
      key(sessionId, 'deleting'), key(sessionId, 'state'), key(sessionId, 'design-md'),
      key(sessionId, 'active'),
    ],
    [
      String(now),
      JSON.stringify({
        type: 'user', at: now, clientId: prompt.clientId, author: prompt.author,
        text: prompt.text, imageCount: prompt.images?.length || undefined,
        imagePreviews: prompt.previews?.length ? prompt.previews : undefined,
      }),
      sessionId,
      Object.keys(initialFields).length ? JSON.stringify(initialFields) : '',
      designMeta ? JSON.stringify(designMeta) : '',
      // Wrapped so the client's JSON auto-parsing can never turn the text into a value.
      design ? JSON.stringify({ text: design.text }) : '',
      sponsored ? '1' : '0',
    ],
  )
  if (raw === false || raw === null) throw new SessionCleanupError()
  const result = parseJson<{ id: number; event: StreamItem; idle?: boolean; trialChat?: boolean; error?: string }>(raw)
  if (result.error === 'not_trial_chat') throw new AuthError(409, 'Free prompts are available in a new design')
  announce(sessionId, result.event)
  return { id: result.id, event: result.event, idle: result.idle === true, trialChat: result.trialChat === true }
}

const APPEND_EVENT = INIT_STATE + `
if redis.call('EXISTS', KEYS[4]) == 1 then return false end
local item = cjson.decode(ARGV[1])
local seq = redis.call('INCR', KEYS[1])
item.seq = seq
redis.call('RPUSH', KEYS[2], cjson.encode(item))
init_state(KEYS[3], ARGV[2], ARGV[3])
return cjson.encode(item)
`

export async function appendEvent(
  sessionId: string,
  entry: Omit<StreamItem, 'seq' | 'at'> & { at?: number },
): Promise<StreamItem> {
  const now = entry.at ?? Date.now()
  const raw = await redis().eval<unknown[], unknown>(
    APPEND_EVENT,
    [key(sessionId, 'event-seq'), key(sessionId, 'events'), key(sessionId, 'state'), key(sessionId, 'deleting')],
    [JSON.stringify({ ...entry, at: now }), sessionId, String(now)],
  )
  if (raw === null || raw === false) throw new SessionCleanupError()
  return announce(sessionId, parseJson<StreamItem>(raw))
}

export async function readEvents(sessionId: string, afterSeq = 0): Promise<StreamItem[]> {
  // Event sequence starts at 1 and the transcript list is append-only, so the
  // sequence itself is the zero-based LRANGE offset for the next item.
  const events = (await redis().lrange<unknown>(key(sessionId, 'events'), Math.max(0, afterSeq), -1)) ?? []
  return events
    .map((item) => parseJson<StreamItem>(item))
    .filter((item) => typeof item.seq === 'number' && item.seq > afterSeq)
}

export async function currentSeq(sessionId: string): Promise<number> {
  return Number((await redis().get<number>(key(sessionId, 'event-seq'))) ?? 0)
}

// Read the checkpoint and its tail atomically, including concurrent appends.
const READ_TRANSCRIPT = `
local previous = redis.call('GET', KEYS[1])
local offset = 0
if previous then
  local ok, value = pcall(cjson.decode, previous)
  if ok and value.version == 1 then offset = value.lastSeq else previous = false end
end
return {previous or false, redis.call('LRANGE', KEYS[2], offset, -1),
  redis.call('HGETALL', KEYS[3]), redis.call('EXISTS', KEYS[4])}
`

const PUBLISH_TRANSCRIPT = `
if redis.call('EXISTS', KEYS[3]) == 1 or redis.call('EXISTS', KEYS[2]) == 0 then return 0 end
local previous = redis.call('GET', KEYS[1])
if previous then
  local ok, value = pcall(cjson.decode, previous)
  if ok and value.version == 1 and value.lastSeq >= tonumber(ARGV[1]) then return 0 end
end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`

export async function publishTranscriptSnapshot(id: string, snapshot: TranscriptSnapshot): Promise<void> {
  await redis().eval(PUBLISH_TRANSCRIPT, [key(id, 'transcript'), key(id, 'events'), key(id, 'deleting')],
    [String(snapshot.lastSeq), JSON.stringify(snapshot)])
}

export const readTranscript = createTranscriptReader({
  async read(id) {
    const [previous, tail, fields, busy] = await redis().eval<unknown[], [unknown, unknown[], string[], number]>(
      READ_TRANSCRIPT, [key(id, 'transcript'), key(id, 'events'), key(id, 'state'), key(id, 'active')], [])
    const values: Record<string, string> = {}
    for (let i = 0; i < fields.length; i += 2) values[fields[i]] = fields[i + 1]
    const stored = parseStoredSession(id, values)
    return {
      previous: previous ? parseJson<TranscriptSnapshot>(previous) : null,
      events: tail.map((item) => parseJson<StreamItem>(item)),
      view: sessionView(values),
      summary: stored ? { id, title: stored.title, createdAt: stored.createdAt, lastActivity: stored.lastActivity, busy: busy > 0, ...(stored.trialChat ? { trialChat: true as const } : {}) } : null,
    }
  },
  publish: publishTranscriptSnapshot,
})

const NEXT_QUESTION_ID = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
return redis.call('INCR', KEYS[1])
`
export async function nextQuestionId(sessionId: string): Promise<number> {
  const id = await redis().eval<unknown[], number>(NEXT_QUESTION_ID,
    [key(sessionId, 'question-seq'), key(sessionId, 'deleting')], [])
  if (!id) throw new SessionCleanupError()
  return id
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function nullableBoolean(value: unknown): boolean | null {
  if (value === true || value === 'true' || value === 1 || value === '1') return true
  if (value === false || value === 'false' || value === 0 || value === '0') return false
  return null
}

function sessionView(value: Record<string, unknown> | null): SessionView {
  return { artifactRevision: Number(value?.artifactRevision ?? 0) }
}

function parseStoredSession(sessionId: string, value: Record<string, unknown> | null): StoredSession | null {
  if (!value?.id) return null
  return {
    id: sessionId,
    createdAt: Number(value.createdAt ?? Date.now()),
    lastActivity: Number(value.lastActivity ?? value.createdAt ?? Date.now()),
    title: nullableString(value.title),
    preferredModel: nullableString(value.preferredModel),
    preferredEffort: nullableString(value.preferredEffort),
    preferredFast: nullableBoolean(value.preferredFast),
    designMd: parseDesignMdMeta(value.designMd),
    libfxSessionId: nullableString(value.libfxSessionId),
    artifactTurn: value.artifactTurn == null || value.artifactTurn === '' ? null : Number(value.artifactTurn),
    trialChat: nullableBoolean(value.trialChat) === true,
  }
}

function parseDesignMdMeta(value: unknown): DesignMdMeta | null {
  if (value == null || value === '') return null
  try {
    const meta = parseJson<Partial<DesignMdMeta>>(value)
    if (typeof meta?.name !== 'string' || typeof meta.source !== 'string' || typeof meta.sha !== 'string') return null
    return { name: meta.name, source: meta.source, sha: meta.sha, bytes: Number(meta.bytes ?? 0) }
  } catch {
    return null
  }
}

// Ownership reservation must refuse any id with journal data or a deletion
// tombstone, not just chats with a metadata hash. One bounded Redis round trip.
export async function sessionExists(sessionId: string): Promise<boolean> {
  const parts = [...SESSION_PARTS, 'deleting', 'cleanup']
  return (await redis().exists(...parts.map((part) => key(sessionId, part)))) > 0
}

export async function readSession(sessionId: string): Promise<StoredSession | null> {
  return parseStoredSession(sessionId, await redis().hgetall<Record<string, unknown>>(key(sessionId, 'state')))
}

export async function readSessionView(sessionId: string): Promise<SessionView> {
  return sessionView(await redis().hgetall<Record<string, unknown>>(key(sessionId, 'state')))
}

export async function readDesignArtifact(sessionId: string): Promise<string | null> {
  return (await redis().get<string>(key(sessionId, 'design-artifact'))) ?? null
}

const READ_DESIGN_ARTIFACT_AT = `return {redis.call('GET', KEYS[1]), redis.call('HGET', KEYS[2], 'artifactRevision')}`

// The live design with its revision, read together: publishing writes both in one
// script, so the pair always matches.
export async function readDesignArtifactAt(sessionId: string): Promise<{ html: string | null; revision: number }> {
  const [html, revision] = await redis().eval<unknown[], [unknown, unknown]>(
    READ_DESIGN_ARTIFACT_AT,
    [key(sessionId, 'design-artifact'), key(sessionId, 'state')],
    [],
  )
  return { html: typeof html === 'string' ? html : null, revision: Number(revision ?? 0) }
}

export async function readDesignMd(sessionId: string): Promise<string | null> {
  const stored = await redis().get<unknown>(key(sessionId, 'design-md'))
  if (stored == null) return null
  const { text } = parseJson<{ text?: unknown }>(stored)
  return typeof text === 'string' ? text : null
}

const SESSION_PARTS = [
  'draft',
  'draft-chunks',
  'active',
  'active-question',
  'answer',
  'design-artifact',
  'design-md',
  'event-seq',
  'events',
  'message-seq',
  'projected',
  'question-seq',
  'state',
  'transcript',
] as const

const CLAIM_CLEANUP = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 'missing' end
if redis.call('EXISTS', KEYS[3]) == 1 or redis.call('EXISTS', KEYS[2]) == 1 then return 'busy' end
redis.call('SET', KEYS[3], ARGV[1], 'PX', ARGV[2])
redis.call('SET', KEYS[4], '1')
return 'claimed'
`

export async function claimSessionCleanup(sessionId: string, token: string): Promise<'claimed' | 'busy' | 'missing'> {
  return redis().eval<unknown[], 'claimed' | 'busy' | 'missing'>(CLAIM_CLEANUP,
    [key(sessionId, 'state'), key(sessionId, 'active'), key(sessionId, 'cleanup'), key(sessionId, 'deleting')],
    [token, String(LEASE_MS)],
  )
}

const RENEW_CLEANUP = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`
export async function renewSessionCleanup(sessionId: string, token: string): Promise<boolean> {
  return (await redis().eval<unknown[], number>(RENEW_CLEANUP,
    [key(sessionId, 'cleanup')], [token, String(LEASE_MS)])) === 1
}

// The deleting tombstone is not a session part: it outlives the chat.
// The keys after the session parts include the chat's libfx session mapping.
const FINISH_CLEANUP = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if redis.call('EXISTS', KEYS[2]) == 0 or redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
redis.call('DEL', unpack(KEYS, 4))
redis.call('DEL', KEYS[1])
return 1
`

export async function finishSessionCleanup(sessionId: string, token: string, libfxSessionId: string | null): Promise<boolean> {
  return (await redis().eval<unknown[], number>(FINISH_CLEANUP,
    [key(sessionId, 'cleanup'), key(sessionId, 'state'), key(sessionId, 'active'),
      ...SESSION_PARTS.map((part) => key(sessionId, part)),
      ...(libfxSessionId ? [prefixed(`libfx-session:${libfxSessionId}`)] : [])],
    [token],
  )) === 1
}

const RELEASE_CLEANUP = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1
`
export async function releaseSessionCleanup(sessionId: string, token: string): Promise<void> {
  await redis().eval<unknown[], number>(RELEASE_CLEANUP, [key(sessionId, 'cleanup')], [token])
}

// Caller supplies IDs already selected by account ownership. Batch metadata,
// activity and nonempty-chat checks instead of sending two requests per chat.
export async function readSessionSummaries(ids: string[]): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = []
  for (let offset = 0; offset < ids.length; offset += 200) {
    const batch = ids.slice(offset, offset + 200)
    const pipeline = redis().pipeline()
    for (const id of batch) {
      pipeline.hmget(key(id, 'state'), 'id', 'createdAt', 'lastActivity', 'title', 'trialChat')
      pipeline.exists(key(id, 'active'))
      pipeline.get(key(id, 'message-seq'))
    }
    const values = await pipeline.exec()
    for (let index = 0; index < batch.length; index++) {
      if (Number(values[index * 3 + 2] ?? 0) < 1) continue
      const state = parseStoredSession(batch[index], values[index * 3] as Record<string, unknown> | null)
      if (!state) continue
      sessions.push({ id: state.id, title: state.title, createdAt: state.createdAt,
        lastActivity: state.lastActivity, busy: Number(values[index * 3 + 1] ?? 0) > 0,
        ...(state.trialChat ? { trialChat: true as const } : {}) })
    }
  }
  return sessions.sort((a, b) => b.lastActivity - a.lastActivity).slice(0, 100)
}

const UPDATE_SESSION = INIT_STATE + `
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
init_state(KEYS[1], ARGV[1], ARGV[2])
for name, value in pairs(cjson.decode(ARGV[3])) do redis.call('HSET', KEYS[1], name, value) end
return 1
`

export async function updateSession(
  sessionId: string,
  fields: Partial<Pick<StoredSession, 'preferredModel' | 'preferredEffort' | 'preferredFast'>>,
): Promise<void> {
  const values: Record<string, string> = {}
  for (const [name, value] of Object.entries(fields)) values[name] = value == null ? '' : String(value)
  const updated = await redis().eval<unknown[], number>(
    UPDATE_SESSION,
    [key(sessionId, 'state'), key(sessionId, 'deleting')],
    [sessionId, String(Date.now()), JSON.stringify(values)],
  )
  if (!updated) throw new SessionCleanupError()
}

const PUBLISH_DESIGN_ARTIFACT = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return cjson.encode({status = 'fenced'})
end
if redis.call('HGET', KEYS[6], 'turnId') == ARGV[3] then
  redis.call('HSET', KEYS[6], 'closed', 1, 'published', 1)
  redis.call('DEL', KEYS[7])
end
local revision = tonumber(redis.call('HGET', KEYS[2], 'artifactRevision') or '0')
if redis.call('GET', KEYS[3]) == ARGV[1] then
  return cjson.encode({status = 'unchanged', revision = revision})
end
redis.call('SET', KEYS[3], ARGV[1])
revision = redis.call('HINCRBY', KEYS[2], 'artifactRevision', 1)
local event = {type = 'artifact', artifactRevision = revision, at = tonumber(ARGV[2])}
if ARGV[3] ~= '' then
  event.turnId = tonumber(ARGV[3])
  redis.call('HSET', KEYS[2], 'artifactTurn', ARGV[3])
end
local seq = redis.call('INCR', KEYS[4])
event.seq = seq
redis.call('RPUSH', KEYS[5], cjson.encode(event))
return cjson.encode({status = 'published', revision = revision, event = event})
`

export type PublishDesignArtifactResult =
  | { ok: true; revision: number; changed: boolean; event?: StreamItem }
  | { ok: false; reason: 'invalid' | 'fenced'; error: string }

export async function publishDesignArtifact(
  sessionId: string,
  html: string,
  turnId: number | null = null,
): Promise<PublishDesignArtifactResult> {
  const validation = validateDesignArtifactHtml(html)
  if (!validation.ok) return { ok: false, reason: 'invalid', error: validation.error }

  const raw = await redis().eval<unknown[], unknown>(
    PUBLISH_DESIGN_ARTIFACT,
    [
      key(sessionId, 'deleting'),
      key(sessionId, 'state'),
      key(sessionId, 'design-artifact'),
      key(sessionId, 'event-seq'),
      key(sessionId, 'events'),
      key(sessionId, 'draft'),
      key(sessionId, 'draft-chunks'),
    ],
    // The turn lets the transcript group a turn's revisions under its activity.
    [html, String(Date.now()), turnId == null ? '' : String(turnId)],
  )
  const result = parseJson<{
    status: 'published' | 'unchanged' | 'fenced'
    revision?: number
    event?: StreamItem
  }>(raw)
  if (result.status === 'fenced') {
    return { ok: false, reason: 'fenced', error: 'the chat was deleted before publishing' }
  }
  return {
    ok: true,
    revision: Number(result.revision ?? 0),
    changed: result.status === 'published',
    event: announce(sessionId, result.event),
  }
}

// The projector marks a turn active at its turn_start and clears it at its
// turn_end. The TTL bounds a turn whose end the projector never sees.
const ACTIVE_TURN_MS = 30 * 60_000

export async function setActiveTurn(sessionId: string, turn: ActiveTurn): Promise<void> {
  await redis().set(key(sessionId, 'active'), JSON.stringify(turn), { px: ACTIVE_TURN_MS })
}

export async function getActiveTurn(sessionId: string): Promise<ActiveTurn | null> {
  const value = await redis().get<unknown>(key(sessionId, 'active'))
  return value == null ? null : parseJson<ActiveTurn>(value)
}

// Clears only the turn that ended, never a later one already marked.
const CLEAR_ACTIVE_TURN = `
local value = redis.call('GET', KEYS[1])
if value and cjson.decode(value).id == tonumber(ARGV[1]) then redis.call('DEL', KEYS[1]) end
return 1
`
export async function clearActiveTurn(sessionId: string, turnId: number): Promise<void> {
  await redis().eval<unknown[], number>(CLEAR_ACTIVE_TURN, [key(sessionId, 'active')], [String(turnId)])
}

export interface ActiveQuestion {
  turnId: number
  qid: number
}

// ask_user_question waits in its tool call for an answer, at most this long.
export const QUESTION_WAIT_MS = 600_000

const SET_QUESTION = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return 1
`
export async function setActiveQuestion(sessionId: string, question: ActiveQuestion): Promise<void> {
  const set = await redis().eval<unknown[], number>(SET_QUESTION,
    [key(sessionId, 'active-question'), key(sessionId, 'deleting')],
    [JSON.stringify(question), String(QUESTION_WAIT_MS)])
  if (!set) throw new SessionCleanupError()
}

export async function getActiveQuestion(sessionId: string): Promise<ActiveQuestion | null> {
  const value = await redis().get<unknown>(key(sessionId, 'active-question'))
  return value == null ? null : parseJson<ActiveQuestion>(value)
}

// An answer is accepted once, and only for the question still open.
const ANSWER_QUESTION = `
local value = redis.call('GET', KEYS[1])
if not value or cjson.decode(value).qid ~= tonumber(ARGV[1]) then return 0 end
redis.call('DEL', KEYS[1])
redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3])
return 1
`
export async function answerActiveQuestion(sessionId: string, qid: number, answers: Record<string, string>): Promise<boolean> {
  return (await redis().eval<unknown[], number>(ANSWER_QUESTION,
    [key(sessionId, 'active-question'), key(sessionId, 'answer')],
    [String(qid), JSON.stringify({ qid, answers }), String(QUESTION_WAIT_MS)])) === 1
}

// The waiting tool takes its answer; an answer to another question stays put.
const TAKE_ANSWER = `
local value = redis.call('GET', KEYS[1])
if not value or cjson.decode(value).qid ~= tonumber(ARGV[1]) then return false end
redis.call('DEL', KEYS[1])
return value
`
export async function takeAnswer(sessionId: string, qid: number): Promise<Record<string, string> | null> {
  const raw = await redis().eval<unknown[], unknown>(TAKE_ANSWER, [key(sessionId, 'answer')], [String(qid)])
  return raw == null || raw === false ? null : parseJson<{ answers: Record<string, string> }>(raw).answers
}

// Withdraws the question when its tool call stops waiting. Returns whether it was
// still open, so only one side reports it resolved.
const CLEAR_QUESTION = `
local value = redis.call('GET', KEYS[1])
if not value or cjson.decode(value).qid ~= tonumber(ARGV[1]) then return 0 end
redis.call('DEL', KEYS[1])
return 1
`
export async function clearActiveQuestion(sessionId: string, qid: number): Promise<boolean> {
  return (await redis().eval<unknown[], number>(CLEAR_QUESTION, [key(sessionId, 'active-question')], [String(qid)])) === 1
}

// The first libfx session id stored for a chat wins, so two first prompts racing
// on the same chat still share one conversation. The reverse key lets the agent's
// fetch find the chat from the x-session-id libfx sends with each model request.
const BIND_LIBFX_SESSION = `
if redis.call('EXISTS', KEYS[2]) == 1 then return false end
local current = redis.call('HGET', KEYS[1], 'libfxSessionId')
if current and current ~= '' then return current end
redis.call('HSET', KEYS[1], 'libfxSessionId', ARGV[1])
redis.call('SET', KEYS[3], ARGV[2])
return ARGV[1]
`
export async function bindLibfxSession(sessionId: string, candidate: string): Promise<string> {
  const bound = await redis().eval<unknown[], unknown>(BIND_LIBFX_SESSION,
    [key(sessionId, 'state'), key(sessionId, 'deleting'), prefixed(`libfx-session:${candidate}`)],
    [candidate, sessionId])
  if (typeof bound !== 'string') throw new SessionCleanupError()
  return bound
}

export async function chatOfLibfxSession(libfxSessionId: string): Promise<string | null> {
  return (await redis().get<string>(prefixed(`libfx-session:${libfxSessionId}`))) ?? null
}

export async function projectedCursor(sessionId: string): Promise<number> {
  return Number((await redis().get<number>(key(sessionId, 'projected'))) ?? 0)
}

// Appends the items copied from libfx's stream between two cursors, only if no
// other projector moved the cursor first: each libfx line reaches the transcript
// once however many projectors follow the chat.
const PROJECT_EVENTS = INIT_STATE + `
if redis.call('EXISTS', KEYS[4]) == 1 then return false end
if tonumber(redis.call('GET', KEYS[5]) or '0') ~= tonumber(ARGV[1]) then return false end
local items = cjson.decode(ARGV[3])
local out = {}
for i, item in ipairs(items) do
  if item.type == 'done' or item.type == 'error' then
    local turn = item.turnId or item.id or 0
    local closed = tonumber(redis.call('HGET', KEYS[3], 'draftClosedTurn') or '0')
    redis.call('HSET', KEYS[3], 'draftClosedTurn', math.max(closed, turn))
    if tonumber(redis.call('HGET', KEYS[6], 'turnId') or '0') == turn then
      redis.call('HSET', KEYS[6], 'closed', 1)
      redis.call('DEL', KEYS[7])
    end
  end
  item.seq = redis.call('INCR', KEYS[1])
  local encoded = cjson.encode(item)
  redis.call('RPUSH', KEYS[2], encoded)
  out[i] = encoded
end
redis.call('SET', KEYS[5], ARGV[2])
init_state(KEYS[3], ARGV[4], ARGV[5])
return out
`
export async function projectEvents(
  sessionId: string,
  fromCursor: number,
  toCursor: number,
  entries: (Omit<StreamItem, 'seq'>)[],
): Promise<StreamItem[] | null> {
  const raw = await redis().eval<unknown[], unknown>(PROJECT_EVENTS,
    [key(sessionId, 'event-seq'), key(sessionId, 'events'), key(sessionId, 'state'), key(sessionId, 'deleting'),
      key(sessionId, 'projected'), key(sessionId, 'draft'), key(sessionId, 'draft-chunks')],
    [String(fromCursor), String(toCursor), JSON.stringify(entries), sessionId, String(Date.now())])
  if (raw === null || raw === false) return null
  // An empty Lua table comes back as an empty array or an empty object.
  const items = Array.isArray(raw) ? raw.map((item) => parseJson<StreamItem>(item)) : []
  for (const item of items) announce(sessionId, item)
  return items
}
