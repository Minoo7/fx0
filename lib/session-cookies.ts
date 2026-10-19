export const SESSION_TTL_SECONDS = 90 * 24 * 60 * 60

// First-paint UI only. The server always verifies the sealed session itself.
export const SIGNED_IN_HINT_COOKIE = 'fx0-signed-in'

// Denies use of an existing grant while logout is pending, including across a
// reload. It never proves that revocation succeeded or grants authentication.
export const SIGN_OUT_PENDING_COOKIE = 'fx0-signout-pending'

export function signOutPendingCookie(pending: boolean, secure: boolean): string {
  return [
    `${SIGN_OUT_PENDING_COOKIE}=${pending ? '1' : ''}`, 'Path=/',
    `Max-Age=${pending ? SESSION_TTL_SECONDS : 0}`, 'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ')
}

export function signedInHintCookie(signedIn: boolean, secure: boolean): string {
  return [
    `${SIGNED_IN_HINT_COOKIE}=${signedIn ? '1' : ''}`, 'Path=/',
    `Max-Age=${signedIn ? SESSION_TTL_SECONDS : 0}`, 'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ')
}
