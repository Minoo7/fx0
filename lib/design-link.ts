// The longest address a design may ask to open: the confirmation shows all of it,
// so anything the design packed into the address is visible before it is sent.
export const MAX_DESIGN_LINK_LENGTH = 2048

// A design can only ask the app to open a link; the user opens it from the app's
// own dialog. This is the address that dialog may offer, or null: an https page,
// with no username or password, short enough to show whole.
export function designLinkUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_DESIGN_LINK_LENGTH) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null
  return url.href.length <= MAX_DESIGN_LINK_LENGTH ? url.href : null
}
