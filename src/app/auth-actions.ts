'use server'

import { revalidatePath } from 'next/cache'
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server'

import {
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  isCorrectPassword,
  isProtected,
  isValidSession,
  issueSession,
  safeNext,
} from '../lib/auth.ts'
import {
  CHALLENGE_COOKIE,
  CHALLENGE_MAX_AGE,
  authenticationOptions,
  forgetPasskey,
  mintChallenge,
  readChallenge,
  registrationOptions,
  saveRegistration,
  verifyAssertion,
} from '../lib/webauthn.ts'

export type SignInState = { error: string | null }

/** What a ceremony's first step hands the browser: something to sign, or a reason it cannot. */
export type Begun<Options> = { ok: true; options: Options } | { ok: false; error: string }

/**
 * A guess costs a request, so make requests cost something back.
 *
 * Only the password needs this. A passkey assertion cannot be guessed at all,
 * so the only thing throttling it would slow down is someone signing in.
 *
 * One process, one household, one shared password - an in-memory counter is the
 * right size for the threat. It resets when the container restarts, which is
 * fine: restarting the app is not an attack anyone can arrange from outside.
 */
const WINDOW_MS = 60_000
const MAX_ATTEMPTS = 8

const attempts = new Map<string, { count: number; resetAt: number }>()

function tooManyAttempts(key: string, now: number): boolean {
  for (const [id, entry] of attempts) {
    if (entry.resetAt <= now) attempts.delete(id)
  }

  return (attempts.get(key)?.count ?? 0) >= MAX_ATTEMPTS
}

function noteFailure(key: string, now: number): void {
  const entry = attempts.get(key)

  if (!entry || entry.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS })
    return
  }

  entry.count += 1
}

/**
 * Whoever is knocking.
 *
 * The last entry in X-Forwarded-For, not the first. A client can send the header
 * itself and the proxy appends rather than replaces, so the leftmost value is
 * whatever the caller felt like typing - and a rate limit keyed on a value the
 * attacker chooses is not a rate limit. The rightmost entry is the one our own
 * proxy wrote.
 *
 * Behind two proxies the rightmost is the outer proxy, so everyone shares one
 * bucket. That errs towards limiting too much, which is the right way to be
 * wrong here.
 */
async function caller(): Promise<string> {
  const forwarded = (await headers()).get('x-forwarded-for')?.split(',')
  return forwarded?.[forwarded.length - 1]?.trim() || 'unknown'
}

async function startSession(): Promise<void> {
  const store = await cookies()

  store.set(SESSION_COOKIE, await issueSession(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_MAX_AGE,
  })
}

async function setChallenge(purpose: 'register' | 'authenticate', challenge: string) {
  const store = await cookies()

  store.set(CHALLENGE_COOKIE, await mintChallenge(purpose, challenge), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: CHALLENGE_MAX_AGE,
  })
}

async function takeChallenge(purpose: 'register' | 'authenticate'): Promise<string | null> {
  const store = await cookies()
  const challenge = await readChallenge(purpose, store.get(CHALLENGE_COOKIE)?.value)

  // Used or not, it is spent. A challenge that survives its ceremony is a
  // challenge that can be answered twice.
  store.delete(CHALLENGE_COOKIE)

  return challenge
}

/**
 * Registering a passkey is a signed-in action, which is what makes the whole
 * scheme hold together: the password is the root of trust, and every passkey
 * descends from someone who knew it.
 *
 * Middleware already gates the page this is called from. This is the second
 * lock on the same door, on the server that actually writes the row.
 */
async function signedIn(): Promise<boolean> {
  if (!isProtected()) return true

  const store = await cookies()
  return isValidSession(store.get(SESSION_COOKIE)?.value)
}

// --------------------------------------------------------------- password --

export async function signIn(_state: SignInState, form: FormData): Promise<SignInState> {
  if (!isProtected()) redirect('/')

  const destination = safeNext(String(form.get('next') ?? '/'))
  const password = String(form.get('password') ?? '')
  const now = Date.now()
  const key = await caller()

  if (tooManyAttempts(key, now)) {
    return { error: 'Too many attempts. Wait a minute and try again.' }
  }

  if (!isCorrectPassword(password)) {
    noteFailure(key, now)
    return { error: 'That is not the password.' }
  }

  attempts.delete(key)
  await startSession()

  redirect(destination)
}

export async function signOut(): Promise<void> {
  const store = await cookies()
  store.delete(SESSION_COOKIE)

  redirect('/login')
}

// ---------------------------------------------------------- passkey: in --

export async function beginPasskeySignIn(): Promise<Begun<PublicKeyCredentialRequestOptionsJSON>> {
  if (!isProtected()) {
    return { ok: false, error: 'This ledger has no password set, so there is nothing to unlock.' }
  }

  const { options, challenge } = await authenticationOptions()
  await setChallenge('authenticate', challenge)

  return { ok: true, options }
}

export async function finishPasskeySignIn(
  response: AuthenticationResponseJSON,
  next: string,
): Promise<SignInState> {
  if (!isProtected()) redirect('/')

  const challenge = await takeChallenge('authenticate')
  if (!challenge) return { error: 'That took too long. Try the passkey again.' }

  const { error } = await verifyAssertion(response, challenge)
  if (error) return { error }

  await startSession()

  redirect(safeNext(next))
}

// ----------------------------------------------------- passkey: managing --

export async function beginPasskeyRegistration(): Promise<
  Begun<PublicKeyCredentialCreationOptionsJSON>
> {
  if (!(await signedIn())) return { ok: false, error: 'Sign in before adding a passkey.' }

  if (!isProtected()) {
    return {
      ok: false,
      error: 'Set APP_PASSWORD before adding passkeys, or there is nothing to add one to.',
    }
  }

  const { options, challenge } = await registrationOptions()
  await setChallenge('register', challenge)

  return { ok: true, options }
}

export async function finishPasskeyRegistration(
  response: RegistrationResponseJSON,
  label: string,
): Promise<{ error: string | null }> {
  if (!(await signedIn())) return { error: 'Sign in before adding a passkey.' }

  const challenge = await takeChallenge('register')
  if (!challenge) return { error: 'That took too long. Try adding it again.' }

  const named = label.trim() || 'Unnamed passkey'
  const { error } = await saveRegistration(response, challenge, named.slice(0, 60))
  if (error) return { error }

  revalidatePath('/accounts')

  return { error: null }
}

export async function removePasskey(id: string): Promise<{ error: string | null }> {
  if (!(await signedIn())) return { error: 'Sign in before removing a passkey.' }

  await forgetPasskey(id)
  revalidatePath('/accounts')

  return { error: null }
}
