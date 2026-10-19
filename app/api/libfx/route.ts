import { agent } from '../../../lib/agent'

// Each delivery runs a turn until this deadline, and the next invocation runs
// the rest.
export const maxDuration = 800

// Vercel Queues delivers here the turns no request runs itself (the trigger is
// in vercel.json): the rest of a turn that outlasted its prompt request, and a
// prompt's backstop when that request died.
export const POST = agent().wakeHandler()
