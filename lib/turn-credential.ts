import { sealData, unsealData } from 'iron-session'
// @ts-expect-error Node strip-types tests require the source extension.
import { prefixed, redis } from './journal.ts'
import type { SessionData } from './secure-session'
// @ts-expect-error Node strip-types tests require the source extension.
import { trialEnabled, type TrialCredential } from './trial.ts'

// libfx runs a chat's turns in queue deliveries, with no user request to read a
// cookie from. So the prompt route leaves the sender's AI Gateway credential
// here, and the agent's fetch bills every model request of that chat to it:
// the access token and team only, sealed with SESSION_SECRET and expiring with
// the token. The refresh token never leaves the cookie, and nothing here is
// logged. Deleting this module, and the fetch that reads it, bills the
// deployment instead.
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

interface FundingBinding { kind: 'trial' | 'user'; userId: string; loginId: string; teamId?: string }

// Stores the credential that bills `chatId` from now on. A credential that has
// already expired is not stored.
export async function saveTurnCredential(chatId: string, session: SessionData, turnId?: number): Promise<void> {
  const ttlSeconds = Math.floor((session.expiresAt - Date.now()) / 1000)
  if (!session.accessToken || !session.teamId || !session.loginId || ttlSeconds <= 0) return
  const credential: UserTurnCredential = {
    userId: session.userId,
    loginId: session.loginId,
    accessToken: session.accessToken,
    teamId: session.teamId,
    expiresAt: session.expiresAt,
  }
  await storeCredential(chatId, credential, ttlSeconds, turnId)
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
  // Latest OAuth grants still serve token renewal and old paid-only chats.
  // A sponsored admission never replaces that user's credential.
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

// The SDK's actual executing message selects funding, including after a cold
// restore. Redis projection timing and later submitted messages confer no billing
// authority. Legacy fallback exists only where no explicit turn records exist.
export async function readExecutionCredential(chatId: string, turnId?: number): Promise<TurnCredential | null> {
  // Check after selecting the credential, including old records and exact-turn
  // fallbacks. Never cache a negative revocation check across model requests.
  return activeCredential(await storedExecutionCredential(chatId, turnId))
}

async function storedExecutionCredential(chatId: string, turnId?: number): Promise<TurnCredential | null> {
  const validTurn = Number.isSafeInteger(turnId) && (turnId as number) > 0
  const pipeline = redis().pipeline().hlen(fundingKey(chatId)).get(credentialKey(chatId))
  if (validTurn) pipeline.hget(fundingKey(chatId), String(turnId)).get(turnCredentialKey(chatId, turnId!))
  const values: unknown[] = await pipeline.exec()
  const [count, latestSeal, bindingValue, turnSeal] = values
  const latest = await decodeCredential(latestSeal)
  if (Number(count) === 0) return latest && !('kind' in latest) ? latest : null
  if (!validTurn) return null
  const binding = fundingBinding(bindingValue)
  if (!binding) return null
  const exact = await decodeCredential(turnSeal)
  if (binding.kind === 'trial') return exact && 'kind' in exact && exact.userId === binding.userId && exact.loginId === binding.loginId ? exact : null
  if (latest && !('kind' in latest) && latest.userId === binding.userId && latest.loginId === binding.loginId) {
    // Rotation may change the selected team, but this turn retains the team its
    // admission selected. The refreshed OAuth token is usable only for that team.
    return { ...latest, teamId: binding.teamId! }
  }
  return exact && !('kind' in exact) && exact.userId === binding.userId && exact.loginId === binding.loginId && exact.teamId === binding.teamId ? exact : null
}

// Sign-out: removes every chat credential this login stored, but not one a later
// prompt from another login of the user has since replaced.
export async function dropLoginCredentials(loginId: string): Promise<string[]> {
  const chats = (await redis().smembers(loginKey(loginId))) ?? []
  // One round trip reads every chat's credential and funding; a second deletes.
  const pipeline = redis().pipeline()
  for (const chatId of chats) pipeline.get(credentialKey(chatId)).hgetall(fundingKey(chatId))
  const values: unknown[] = chats.length ? await pipeline.exec() : []
  const keys: string[] = []
  const dropped: string[] = []
  await Promise.all(chats.map(async (chatId, index) => {
    const credential = await decodeCredential(values[index * 2])
    const bindings = (values[index * 2 + 1] ?? {}) as Record<string, unknown>
    const owned = Object.entries(bindings).filter(([, value]) => fundingBinding(value)?.loginId === loginId)
      .map(([id]) => turnCredentialKey(chatId, Number(id)))
    if (credential && !('kind' in credential) && credential.loginId === loginId) owned.push(credentialKey(chatId))
    if (owned.length) { keys.push(...owned); dropped.push(chatId) }
  }))
  await redis().del(...keys, loginKey(loginId))
  return dropped
}

export async function dropChatCredential(chatId: string): Promise<void> {
  const bindings = await redis().hgetall<Record<string, unknown>>(fundingKey(chatId)) ?? {}
  await redis().del(credentialKey(chatId), fundingKey(chatId), ...Object.keys(bindings).map(id => turnCredentialKey(chatId, Number(id))))
}
