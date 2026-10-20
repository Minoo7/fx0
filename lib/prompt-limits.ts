// One prompt's text, checked in the composer and again by /api/prompt. With the
// 3 MiB of images, their previews and a DESIGN.md, a full prompt still fits in
// one function request body (4.5 MB) and far inside libfx's 8 MiB durable input.
export const PROMPT_TEXT_MAX_BYTES = 256 * 1024

export const PROMPT_TEXT_LIMIT_ERROR = 'prompt text must be 256 KB or smaller.'

export function promptTextBytes(text: string): number {
  return new TextEncoder().encode(text).byteLength
}
