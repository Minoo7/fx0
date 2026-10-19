import { initBotId } from 'botid/client/core'

if (process.env.NEXT_PUBLIC_FX0_FREE_PROMPTS === '1') {
  initBotId({ protect: [{ path: '/api/prompt', method: 'POST' }] })
}
