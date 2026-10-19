import { sealData, unsealData } from 'iron-session'
// @ts-expect-error Node strip-types tests require the source extension.
import { prefixed, redis } from './journal.ts'
import type { SessionData } from './secure-session'
// @ts-expect-error Node strip-types tests require the source extension.
import { trialEnabled, type TrialCredential } from './trial.ts'

// libfx runs a chat's turns in queue deliveries, with no user request to read a
// cookie from. So the prompt route leaves the sender's AI Gateway credential
// here, pinned to the turn its message starts, and the agent's fetch bills each
// model request to its turn's credential: the access token and team only,
// sealed with SESSION_SECRET and expiring with the token. The refresh token
// never leaves the cookie, and no credential is logged. Deleting this module,
// and the fetch that reads it, bills the deployment instead.
interface UserTurnCredential {
  userId: string
  loginId: string
  accessToken: string
  teamId: string
  expiresAt: number
}
export type TurnCredential = UserTurnCredential | TrialCredential

function password(): string {
  const secret = process.env.SESSION_SECRET
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters')
  return secret
}

const credentialKey = (chatId: string) => prefixed(`credential:${chatId}`)
const fundingKey = (chatId: string) => prefixed(`funding:${chatId}`)
const turnCredentialKey = (chatId: string, turnId: number) => `${credentialKey(chatId)}:turn:${turnId}`
const loginKey = (loginId: string) => prefixed(`login-chats:${loginId}`)
const revokedLoginKey = (loginId: string) => prefixed(`revoked-login:${loginId}`)

async function loginRevoked(loginId: string): Promise<boolean> {
  return await redis().get(revokedLoginKey(loginId)) !== null
}

// One durable write fences this login before sign-out succeeds. Do not expire or
// remove the marker: a delayed request can still rotate and reseal an old grant.
// It contains no token; a new sign-in gets a different random login id.
export async function revokeLoginCredentials(loginId: string): Promise<void> {
  await redis().set(revokedLoginKey(loginId), '1')
}

async function activeCredential<T extends TurnCredential>(credential: T | null): Promise<T | null> {
  return credential && !await loginRevoked(credential.loginId) ? credential : null
}

export interface FundingBinding { kind: 'trial' | 'user'; userId: string; loginId: string; teamId?: string }

// Pins the sender's credential to the turn its message starts, and keeps it as
// the chat's latest credential for token renewal. Every paid message is pinned;
// one whose credential can't be stored is not admitted.
export async function saveTurnCredential(chatId: string, session: SessionData, turnId: number): Promise<void> {
  const stored = userCredential(session)
  if (!stored) throw new Error('Sign in again to send this message')
  await storeCredential(chatId, stored.credential, stored.ttlSeconds, turnId)
}

// A renewed token for the chat's latest credential. It reaches the turns its
// login funded, each still billing its own team, and pins no turn. An expired
// token is not stored.
export async function renewLatestCredential(chatId: string, session: SessionData): Promise<void> {
  const stored = userCredential(session)
  if (stored) await storeCredential(chatId, stored.credential, stored.ttlSeconds)
}

function userCredential(session: SessionData): { credential: UserTurnCredential; ttlSeconds: number } | null {
  const ttlSeconds = Math.floor((session.expiresAt - Date.now()) / 1000)
  if (!session.accessToken || !session.teamId || !session.loginId || ttlSeconds <= 0) return null
  return {
    credential: {
      userId: session.userId,
      loginId: session.loginId,
      accessToken: session.accessToken,
      teamId: session.teamId,
      expiresAt: session.expiresAt,
    },
    ttlSeconds,
  }
}

export async function saveTrialCredential(chatId: string, credential: TrialCredential, turnId: number): Promise<void> {
  const ttlSeconds = Math.floor((credential.expiresAt - Date.now()) / 1000)
  if (!trialEnabled() || credential.kind !== 'trial' || !credential.userId || !credential.loginId || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('Free prompts are temporarily unavailable')
  }
  await storeCredential(chatId, { kind: 'trial', userId: credential.userId, loginId: credential.loginId, expiresAt: credential.expiresAt }, ttlSeconds, turnId)
}

async function storeCredential(chatId: string, credential: TurnCredential, ttlSeconds: number, turnId?: number): Promise<void> {
  if (turnId !== undefined && (!Number.isSafeInteger(turnId) || turnId <= 0)) throw new Error('Invalid funding turn')
  if (await loginRevoked(credential.loginId)) throw new Error('Signed out. Sign in again.')
  const sealed = await sealData(credential, { password: password(), ttl: ttlSeconds })
  const pipeline = redis().pipeline()
  const sponsored = 'kind' in credential
  // The latest user credential serves token renewal, and the chats whose turns
  // predate funding records. A sponsored admission never replaces it.
  if (!sponsored) pipeline.set(credentialKey(chatId), sealed, { ex: ttlSeconds })
  if (turnId !== undefined) {
    const binding: FundingBinding = { kind: sponsored ? 'trial' : 'user', userId: credential.userId,
      loginId: credential.loginId, ...(!sponsored ? { teamId: credential.teamId } : {}) }
    pipeline.set(turnCredentialKey(chatId, turnId), sealed, { ex: ttlSeconds })
      // This non-secret marker survives expiry/revocation, so a missing trial
      // credential can never fall back to the customer's latest paid grant.
      .hset(fundingKey(chatId), { [String(turnId)]: JSON.stringify(binding) })
  }
  await pipeline.sadd(loginKey(credential.loginId), chatId)
    // The index outlives no credential it lists: a login's tokens expire too.
    .expire(loginKey(credential.loginId), ttlSeconds, 'GT')
    .exec()
}

async function decodeCredential(sealed: unknown): Promise<TurnCredential | null> {
  if (typeof sealed !== 'string') return null
  if (!sealed) return null
  try {
    const credential = await unsealData<Partial<TurnCredential>>(sealed, { password: password() })
    if ('kind' in credential && credential.kind === 'trial') {
      return credential.userId && credential.loginId && typeof credential.expiresAt === 'number' && Number.isFinite(credential.expiresAt) && credential.expiresAt > Date.now()
        ? { kind: 'trial', userId: credential.userId, loginId: credential.loginId, expiresAt: credential.expiresAt }
        : null
    }
    if (!credential.accessToken || !credential.teamId || !credential.loginId || !credential.userId ||
        typeof credential.expiresAt !== 'number' || !Number.isFinite(credential.expiresAt) || credential.expiresAt <= Date.now()) return null
    return credential as TurnCredential
  } catch {
    return null
  }
}

export async function readTurnCredential(chatId: string): Promise<UserTurnCredential | null> {
  const credential = await decodeCredential(await redis().get(credentialKey(chatId)))
  return activeCredential(credential && !('kind' in credential) ? credential : null)
}

function fundingBinding(value: unknown): FundingBinding | null {
  try {
    const binding = (typeof value === 'string' ? JSON.parse(value) : value) as Partial<FundingBinding> | null
    return binding && (binding.kind === 'trial' || binding.kind === 'user') && typeof binding.userId === 'string' && typeof binding.loginId === 'string' &&
      (binding.kind === 'trial' || typeof binding.teamId === 'string') ? binding as FundingBinding : null
  } catch { return null }
}

// Why a model request has no funding: the executing turn is unknown, it has no
// funding record in a chat that keeps them, its credential is gone, expired or
// no longer matches its record, or its login has signed out.
export type FundingRefusal = 'no-turn' | 'unbound-turn' | 'unusable' | 'revoked'
export type ExecutionFunding = { ok: true; credential: TurnCredential } | { ok: false; refused: FundingRefusal }

const refuse = (refused: FundingRefusal): ExecutionFunding => ({ ok: false, refused })

// What funds a turn's model request, from the chat's records alone. A turn with
// a funding record bills that record's user, login and team, or nothing: later
// messages and renewals can change only the token. A chat with no records at
// all predates per-turn funding and bills its latest user credential.
export function resolveFunding(
  records: number,
  turnId: number | null,
  binding: FundingBinding | null,
  exact: TurnCredential | null,
  latest: TurnCredential | null,
): ExecutionFunding {
  if (records === 0) return latest && !('kind' in latest) ? { ok: true, credential: latest } : refuse('unusable')
  if (turnId === null) return refuse('no-turn')
  if (!binding) return refuse('unbound-turn')
  const sameLogin = (credential: TurnCredential | null) =>
    credential?.userId === binding.userId && credential.loginId === binding.loginId
  if (binding.kind === 'trial') return exact && 'kind' in exact && sameLogin(exact) ? { ok: true, credential: exact } : refuse('unusable')
  // Rotation may change the selected team, but this turn retains the team its
  // admission selected. The refreshed OAuth token is usable only for that team.
  if (latest && !('kind' in latest) && sameLogin(latest)) return { ok: true, credential: { ...latest, teamId: binding.teamId! } }
  return exact && !('kind' in exact) && sameLogin(exact) && exact.teamId === binding.teamId
    ? { ok: true, credential: exact } : refuse('unusable')
}

// The SDK's actual executing message selects funding, including after a cold
// restore. Redis projection timing and later submitted messages confer no billing
// authority. A signed-out login's credential funds nothing: the check runs after
// selection, on every request, and is never cached.
export async function readExecutionFunding(chatId: string, turnId?: number): Promise<ExecutionFunding> {
  const turn = Number.isSafeInteger(turnId) && (turnId as number) > 0 ? turnId as number : null
  const pipeline = redis().pipeline().hlen(fundingKey(chatId)).get(credentialKey(chatId))
  if (turn !== null) pipeline.hget(fundingKey(chatId), String(turn)).get(turnCredentialKey(chatId, turn))
  const values: unknown[] = await pipeline.exec()
  const [count, latestSeal, bindingValue, turnSeal] = values
  const [latest, exact] = await Promise.all([decodeCredential(latestSeal), decodeCredential(turnSeal)])
  const funding = resolveFunding(Number(count), turn, fundingBinding(bindingValue), exact, latest)
  return funding.ok && await loginRevoked(funding.credential.loginId) ? refuse('revoked') : funding
}

// A turn's funding record. Sign-out deletes credentials, never these records.
export async function readTurnFunding(chatId: string, turnId: number): Promise<FundingBinding | null> {
  return fundingBinding(await redis().hget(fundingKey(chatId), String(turnId)))
}

// A chat whose credentials a sign-out dropped, and whether the chat's latest
// credential was that login's.
export interface DroppedChat { chatId: string; latestWasLogin: boolean }

// Sign-out: removes every chat credential this login stored, but not one a later
// prompt from another login of the user has since replaced.
export async function dropLoginCredentials(loginId: string): Promise<DroppedChat[]> {
  const chats = (await redis().smembers(loginKey(loginId))) ?? []
  // One round trip reads every chat's credential and funding; a second deletes.
  // The seal is decoded directly: sign-out has already revoked this login.
  const pipeline = redis().pipeline()
  for (const chatId of chats) pipeline.get(credentialKey(chatId)).hgetall(fundingKey(chatId))
  const values: unknown[] = chats.length ? await pipeline.exec() : []
  const keys: string[] = []
  const dropped: DroppedChat[] = []
  await Promise.all(chats.map(async (chatId, index) => {
    const credential = await decodeCredential(values[index * 2])
    const bindings = (values[index * 2 + 1] ?? {}) as Record<string, unknown>
    const owned = Object.entries(bindings).filter(([, value]) => fundingBinding(value)?.loginId === loginId)
      .map(([id]) => turnCredentialKey(chatId, Number(id)))
    const latestWasLogin = !!credential && !('kind' in credential) && credential.loginId === loginId
    if (latestWasLogin) owned.push(credentialKey(chatId))
    if (owned.length) { keys.push(...owned); dropped.push({ chatId, latestWasLogin }) }
  }))
  await redis().del(...keys, loginKey(loginId))
  return dropped
}

export async function dropChatCredential(chatId: string): Promise<void> {
  const bindings = await redis().hgetall<Record<string, unknown>>(fundingKey(chatId)) ?? {}
  await redis().del(credentialKey(chatId), fundingKey(chatId), ...Object.keys(bindings).map(id => turnCredentialKey(chatId, Number(id))))
}
