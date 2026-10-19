let prompt: HTMLTextAreaElement | null = null

export function registerPrompt(element: HTMLTextAreaElement | null) {
  prompt = element
}

// Anything that is not itself a text field hands focus back to the prompt, so the
// next keystroke always types. Skipped on touch, where it would raise the keyboard.
export function focusPrompt() {
  if (typeof window === 'undefined' || window.matchMedia('(pointer: coarse)').matches) return
  requestAnimationFrame(() => prompt?.focus())
}
