/**
 * The passkey ceremonies, and the small amount of state they need.
 *
 * Server-only: this reaches the database and reads request headers, so nothing
 * here may be imported into a client component or into middleware.
 *
 * The shape of both ceremonies is the same. The server issues a challenge, the
 * authenticator signs it, the server checks the signature against a public key
 * it stored earlier. The only interesting local decisions are where the
 * challenge lives in between (a signed cookie, see auth.ts) and who the
 * relying party is (whatever host the request arrived on).
 */

import { headers } from 'next/headers'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import { isoBase64URL } from '@simplewebauthn/server/helpers'
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server'

import { mintTicket, readTicket } from './auth.ts'
import { db } from './db.ts'

export const CHALLENGE_COOKIE = 'ledger_challenge'

/** A minute is a long time to hold a phone up to your face. */
export const CHALLENGE_MAX_AGE = 120

const RP_NAME = "Ru's Ledger"

/**
 * There is one account, so it needs one stable identifier and no user table.
 *
 * A fixed UUID rather than a generated one: a password manager keys its stored
 * passkeys by this, so changing it would make every registered passkey look
 * like it belongs to a different account and quietly stack up duplicates.
 */
const USER_HANDLE = new TextEncoder().encode('7f3d3e2c-0a1b-4c5d-8e9f-ledgerhousehold')

export type Passkey = {
  id: string
  label: string
  createdAt: Date
  lastUsedAt: Date | null
  /** 'multiDevice' means it syncs through iCloud or a password manager and survives losing the phone. */
  deviceType: string | null
  backedUp: boolean
}

/** What verification needs: the public key, the counter to compare against, and how to reach it. */
type CredentialRow = { id: string; public_key: string; counter: string; transports: string[] }

/**
 * Who we are, according to the request.
 *
 * Derived from the host header rather than configured, because a passkey is
 * bound to the domain it was made on and the app already knows which domain it
 * was reached on. WEBAUTHN_RP_ID exists for the one case that cannot be
 * derived: a deployment served from several hostnames that should share one set
 * of passkeys, where the ID has to be the registrable parent of all of them.
 */
async function relyingParty(): Promise<{ rpID: string; origin: string }> {
  const head = await headers()
  const host = head.get('x-forwarded-host') ?? head.get('host')

  if (!host) throw new Error('No Host header, so there is no relying party to be')

  const forwardedProto = head.get('x-forwarded-proto')?.split(',')[0]?.trim()
  const local = host.startsWith('localhost') || host.startsWith('127.0.0.1')
  const proto = forwardedProto ?? (local ? 'http' : 'https')

  return {
    rpID: process.env.WEBAUTHN_RP_ID?.trim() || host.split(':')[0]!,
    origin: `${proto}://${host}`,
  }
}

// ---------------------------------------------------------------- storage --

export async function listPasskeys(): Promise<Passkey[]> {
  const rows = await db<
    {
      id: string
      label: string
      device_type: string | null
      backed_up: boolean
      created_at: Date
      last_used_at: Date | null
    }[]
  >`
    select id, label, device_type, backed_up, created_at, last_used_at
    from passkeys
    order by created_at desc
  `

  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    deviceType: row.device_type,
    backedUp: row.backed_up,
  }))
}

export async function hasPasskeys(): Promise<boolean> {
  const [row] = await db<{ any: boolean }[]>`select exists (select 1 from passkeys) as any`
  return row?.any ?? false
}

export async function forgetPasskey(id: string): Promise<void> {
  await db`delete from passkeys where id = ${id}`
}

// ----------------------------------------------------------- registration --

/**
 * Step one of adding a passkey: what the browser should ask the authenticator.
 *
 * The challenge comes back alongside the options and belongs in a cookie -
 * signed, so a client cannot pick its own and replay a captured response
 * against it later.
 */
export async function registrationOptions(): Promise<{
  options: PublicKeyCredentialCreationOptionsJSON
  challenge: string
}> {
  const { rpID } = await relyingParty()

  const existing = await db<{ id: string; transports: string[] }[]>`
    select id, transports from passkeys
  `

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: 'ledger',
    userDisplayName: RP_NAME,
    userID: USER_HANDLE,
    attestationType: 'none',
    // Registering the same authenticator twice makes two rows that mean the
    // same thing, and a sign-in prompt that offers you the same face twice.
    excludeCredentials: existing.map((row) => ({
      id: row.id,
      transports: row.transports as AuthenticatorTransportFuture[],
    })),
    authenticatorSelection: {
      // Discoverable, so signing in never has to ask who you are first: the
      // browser already knows which passkey belongs to this site.
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  })

  return { options, challenge: options.challenge }
}

/**
 * Step two: check what came back, and store the public half.
 *
 * Returns an error string rather than throwing, because every failure here is
 * something to put in front of the person holding the phone.
 */
export async function saveRegistration(
  response: RegistrationResponseJSON,
  expectedChallenge: string,
  label: string,
): Promise<{ error: string | null }> {
  const { rpID, origin } = await relyingParty()

  let verification
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      // The authenticator proves someone is present; whether it also checks a
      // face or a PIN is the device's business. Requiring it turns a working
      // security key into a mysterious failure.
      requireUserVerification: false,
    })
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'That passkey could not be verified.' }
  }

  if (!verification.verified) return { error: 'That passkey could not be verified.' }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo

  await db`
    insert into passkeys (id, public_key, counter, transports, label, device_type, backed_up)
    values (
      ${credential.id},
      ${isoBase64URL.fromBuffer(credential.publicKey)},
      ${credential.counter},
      ${(credential.transports ?? []) as string[]},
      ${label},
      ${credentialDeviceType},
      ${credentialBackedUp}
    )
    on conflict (id) do update set label = excluded.label
  `

  return { error: null }
}

// --------------------------------------------------------- authentication --

/**
 * Step one of signing in: the challenge, and which credentials may answer it.
 *
 * allowCredentials is left empty so the browser offers whatever it has for this
 * site, including a passkey on a phone that this laptop has never met. The
 * response names the credential it used, and that name is checked against the
 * table before anything is verified.
 */
export async function authenticationOptions(): Promise<{
  options: PublicKeyCredentialRequestOptionsJSON
  challenge: string
}> {
  const { rpID } = await relyingParty()

  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'preferred',
  })

  return { options, challenge: options.challenge }
}

/** Step two: is this a signature by a key we know, over the challenge we issued? */
export async function verifyAssertion(
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
): Promise<{ error: string | null }> {
  const { rpID, origin } = await relyingParty()

  const [row] = await db<CredentialRow[]>`
    select id, public_key, counter, transports from passkeys where id = ${response.id}
  `

  if (!row) return { error: 'That passkey is not registered here.' }

  let verification
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
      credential: {
        id: row.id,
        publicKey: isoBase64URL.toBuffer(row.public_key),
        counter: Number(row.counter),
        transports: row.transports as AuthenticatorTransportFuture[],
      },
    })
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'That passkey could not be verified.' }
  }

  if (!verification.verified) return { error: 'That passkey could not be verified.' }

  // The counter is the clone check, and verifyAuthenticationResponse has
  // already refused anything that went backwards. Storing the new value is what
  // makes the next check mean something.
  await db`
    update passkeys
    set counter = ${verification.authenticationInfo.newCounter}, last_used_at = now()
    where id = ${row.id}
  `

  return { error: null }
}

// ---------------------------------------------------------------- tickets --

/**
 * The challenge, on its way to the browser and back.
 *
 * Purpose is baked into the ticket so a registration challenge cannot be
 * answered with a sign-in assertion, or the other way around.
 */
export function mintChallenge(purpose: 'register' | 'authenticate', challenge: string) {
  return mintTicket(`${purpose}:${challenge}`, CHALLENGE_MAX_AGE)
}

export async function readChallenge(
  purpose: 'register' | 'authenticate',
  ticket: string | undefined,
): Promise<string | null> {
  const payload = await readTicket(ticket)
  if (!payload?.startsWith(`${purpose}:`)) return null

  return payload.slice(purpose.length + 1)
}
