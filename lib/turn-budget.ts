// @ts-expect-error Node strip-types tests require the source extension.
import { prefixed, redis } from './journal.ts'

// A turn's model requests, its subagents' included, counted against the turn's
// step limit. Each request is named by who sent it and what conversation it
// carries (see modelStepName): a retry or a crash's resend counts once, and every
// real step counts again. One script adds the name and counts, so two subagents
// running at once cannot both take the last step.
const RESERVE = `
redis.call('HSETNX', KEYS[1], ARGV[1], 1)
redis.call('EXPIRE', KEYS[1], ARGV[2])
return redis.call('HLEN', KEYS[1])
`
// Longer than any turn runs, so a recovered turn keeps what it already spent.
const TTL_SECONDS = 24 * 60 * 60

interface TurnBudgetRedis {
  eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown>
}

export function createTurnBudget(client: TurnBudgetRedis, prefix: string) {
  return {
    // How many model requests the turn has made, counting this one.
    async reserve(chatId: string, turnId: number, step: string): Promise<number> {
      const count = Number(await client.eval(RESERVE, [`${prefix}:${chatId}:${turnId}`], [step, TTL_SECONDS]))
      if (!Number.isSafeInteger(count) || count < 1) throw new Error('Invalid turn step count')
      return count
    },
  }
}

export function turnBudget() {
  return createTurnBudget(redis(), prefixed('turn-steps'))
}
