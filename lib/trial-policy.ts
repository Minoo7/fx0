// Shared by the free-prompt UI and its server-side funding gate.
export const TRIAL_MODEL = 'anthropic/claude-opus-5.5-fast'
export const FREE_PROMPTS = 5

// The picker shows the "-fast" id as its base model with fast on; both are the trial model.
export function usesFreePrompts(model: string, effort: string, fast = false): boolean {
  const trialModel = model === TRIAL_MODEL || (fast && `${model}-fast` === TRIAL_MODEL)
  return trialModel && (!effort || effort === 'low')
}
