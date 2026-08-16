/**
 * The ticket, which is the whole of the session mechanism.
 *
 * Everything the app trusts about "this browser is allowed in" comes back to
 * these functions: a cookie is only a signature over an expiry, and a passkey
 * challenge is only a signature over a random string. So the assertions worth
 * writing are the four ways a forgery is attempted - no key, wrong key, edited
 * payload, edited expiry - plus the one honest case.
 *
 * No database. The password lives in the environment and the crypto is Web
 * Crypto, so these run anywhere.
 */

import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import {
  appPassword,
  isCorrectPassword,
  isProtected,
  isValidSession,
  issueSession,
  mintTicket,
  readTicket,
  safeNext,
} from '../src/lib/auth.ts'

const ORIGINAL = process.env.APP_PASSWORD

function withPassword(password: string | undefined): void {
  if (password === undefined) delete process.env.APP_PASSWORD
  else process.env.APP_PASSWORD = password
}

afterEach(() => withPassword(ORIGINAL))

describe('protection is off until a password is set', () => {
  test('an empty or missing APP_PASSWORD leaves the app open', () => {
    withPassword(undefined)
    assert.equal(isProtected(), false)
    assert.equal(appPassword(), null)

    // Whitespace is not a password. Someone who set APP_PASSWORD=" " in a
    // Coolify field meant to leave it blank, and the alternative is an app that
    // looks locked and is unlockable by pressing space.
    withPassword('   ')
    assert.equal(isProtected(), false)
  })

  test('nothing validates when there is no key to validate against', async () => {
    withPassword('correct horse battery staple')
    const token = await issueSession()

    withPassword(undefined)
    assert.equal(await isValidSession(token), false)
    assert.equal(isCorrectPassword(''), false)
  })
})

describe('the password itself', () => {
  test('accepts only an exact match', () => {
    withPassword('correct horse battery staple')

    assert.equal(isCorrectPassword('correct horse battery staple'), true)
    assert.equal(isCorrectPassword('correct horse battery stapl'), false)
    assert.equal(isCorrectPassword('Correct horse battery staple'), false)
    assert.equal(isCorrectPassword(''), false)
  })
})

describe('session tickets', () => {
  test('a freshly issued cookie is accepted', async () => {
    withPassword('correct horse battery staple')

    assert.equal(await isValidSession(await issueSession()), true)
  })

  test('an expired cookie is not', async () => {
    withPassword('correct horse battery staple')
    const token = await issueSession()

    const wellAfterThirtyDays = Date.now() + 31 * 24 * 60 * 60 * 1000
    assert.equal(await isValidSession(token, wellAfterThirtyDays), false)
  })

  test('changing the password signs everyone out', async () => {
    withPassword('correct horse battery staple')
    const token = await issueSession()

    withPassword('something else entirely')
    assert.equal(await isValidSession(token), false)
  })

  test('an edited expiry invalidates the signature', async () => {
    withPassword('correct horse battery staple')
    const [payload, expiresAt, signature] = (await issueSession()).split('.') as [
      string,
      string,
      string,
    ]

    const later = String(Number(expiresAt) + 60_000)
    assert.equal(await isValidSession(`${payload}.${later}.${signature}`), false)
  })

  test('a passkey challenge cannot be presented as a session', async () => {
    withPassword('correct horse battery staple')

    // Both are signed with the same key, so the payload is the only thing
    // keeping them apart. If it stopped being checked, anyone who could get a
    // challenge issued - which is anyone at all, from the login page - would
    // hold a valid session cookie.
    const challenge = await mintTicket('authenticate:abc123', 120)

    assert.equal(await readTicket(challenge), 'authenticate:abc123')
    assert.equal(await isValidSession(challenge), false)
  })

  test('junk is rejected rather than thrown at', async () => {
    withPassword('correct horse battery staple')

    for (const token of ['', 'nonsense', 'a.b', 'a.b.c.d', '.'.repeat(3), 'signed-in.abc.xyz']) {
      assert.equal(await isValidSession(token), false, token)
    }
  })
})

describe('the ?next= a signed-out visitor arrives with', () => {
  test('keeps a path on this site', () => {
    assert.equal(safeNext('/budget'), '/budget')
    assert.equal(safeNext('/transactions?period=2026-08-16'), '/transactions?period=2026-08-16')
  })

  test('refuses anywhere else', () => {
    assert.equal(safeNext('https://phishing.example/login'), '/')
    assert.equal(safeNext('//phishing.example'), '/')
    assert.equal(safeNext('javascript:alert(1)'), '/')
    assert.equal(safeNext(undefined), '/')
    assert.equal(safeNext(''), '/')
  })
})
