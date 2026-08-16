/**
 * Who is allowed in.
 *
 * Two ways to prove it, in the order you actually use them:
 *
 *   passkey    the everyday one. Face ID on the phone, Touch ID on the laptop.
 *              Registered credentials live in the `passkeys` table; the
 *              ceremony itself is in webauthn.ts.
 *   password   one shared secret in APP_PASSWORD. The root credential: it is
 *              what you register the first passkey against, and what gets you
 *              back in when the phone holding the passkey is gone.
 *
 * The password is also the switch. Set it and every page and server action is
 * gated; leave it unset and the app is open, which is what you want on a laptop
 * with a throwaway database. Passkeys are offered only when it is set, because
 * a passkey has to be registered by someone already inside.
 *
 * Nothing here is a secret at rest in the browser. A ticket is a payload, an
 * expiry, and an HMAC of both, keyed by the password itself. Three things fall
 * out of that, all of them wanted:
 *
 *   - a stolen cookie is a stolen session and not a stolen password,
 *   - there is no second secret to invent, distribute, or forget to set, and
 *   - changing the password signs everyone out and invalidates every passkey
 *     challenge in flight, because every signature was made with the old key.
 *
 * Web Crypto rather than node:crypto so the same code verifies a request in
 * middleware and issues one in a server action, whichever runtime each is on.
 */

export const SESSION_COOKIE = 'ledger_session'

/** Thirty days. Long enough that a phone stays signed in between paydays. */
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30

const SESSION_PAYLOAD = 'signed-in'

const encoder = new TextEncoder()

/** The configured password, or null when the app is meant to be open. */
export function appPassword(): string | null {
  const value = process.env.APP_PASSWORD?.trim()
  return value ? value : null
}

export function isProtected(): boolean {
  return appPassword() !== null
}

async function sign(payload: string, password: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))

  return base64url(new Uint8Array(mac))
}

export function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/**
 * Compares without leaking, through timing, how much of the input matched.
 *
 * It matters for the password itself far more than for a signature, but the
 * same function does both so there is only one of them to get right.
 */
function equalConstantTime(a: string, b: string): boolean {
  const left = encoder.encode(a)
  const right = encoder.encode(b)

  // Length is not secret - it is visible in the request either way - so an
  // early return here gives nothing away that the response size does not.
  if (left.length !== right.length) return false

  let difference = 0
  for (let i = 0; i < left.length; i++) difference |= left[i]! ^ right[i]!

  return difference === 0
}

export function isCorrectPassword(attempt: string): boolean {
  const password = appPassword()
  return password !== null && equalConstantTime(attempt, password)
}

/**
 * A signed, expiring note to self, safe to hand to a browser.
 *
 * Used for the session cookie and for the passkey challenge, which are the same
 * problem twice: state the server needs back later, unaltered, and does not
 * want to keep a table for. The payload must not contain a dot; every producer
 * here hands it base64url, which cannot.
 */
export async function mintTicket(payload: string, ttlSeconds: number): Promise<string> {
  const password = appPassword()
  if (!password) throw new Error('mintTicket called with no APP_PASSWORD set')

  const body = `${payload}.${Date.now() + ttlSeconds * 1000}`

  return `${body}.${await sign(body, password)}`
}

/** The payload of a ticket this server signed and that has not expired, or null. */
export async function readTicket(
  token: string | undefined,
  now: number = Date.now(),
): Promise<string | null> {
  const password = appPassword()
  if (!password || !token) return null

  const parts = token.split('.')
  if (parts.length !== 3) return null

  const [payload, expiresAt, signature] = parts as [string, string, string]

  if (!/^\d+$/.test(expiresAt) || Number(expiresAt) <= now) return null
  if (!equalConstantTime(signature, await sign(`${payload}.${expiresAt}`, password))) return null

  return payload
}

/** Mints a cookie value good for {@link SESSION_MAX_AGE} seconds. */
export function issueSession(): Promise<string> {
  return mintTicket(SESSION_PAYLOAD, SESSION_MAX_AGE)
}

/**
 * True when the cookie was signed by the current password and has not expired.
 *
 * False when no password is configured: an open app has no sessions to
 * validate, and callers check {@link isProtected} before they get here.
 */
export async function isValidSession(
  token: string | undefined,
  now: number = Date.now(),
): Promise<boolean> {
  return (await readTicket(token, now)) === SESSION_PAYLOAD
}

/**
 * Sanitises the `?next=` a signed-out visitor arrived with.
 *
 * Only a path on this site, never a URL somewhere else - otherwise the login
 * page becomes a convenient way to bounce someone off our domain onto a
 * lookalike of it. A leading `//` is a protocol-relative URL, so it is out too.
 */
export function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/'
  return value
}
