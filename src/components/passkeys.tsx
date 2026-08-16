'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState, useTransition } from 'react'
import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser'

import {
  beginPasskeyRegistration,
  finishPasskeyRegistration,
  removePasskey,
} from '../app/auth-actions.ts'
import type { Passkey } from '../lib/webauthn.ts'
import { instantDate } from '../lib/format.ts'

/**
 * Registering and forgetting passkeys.
 *
 * The label is asked for up front rather than guessed from the user agent,
 * because the only useful name here is the one you would use out loud - "my
 * phone", "work laptop" - and that is the name you need a year later when there
 * are four rows and one of the devices has been sold.
 */
export function Passkeys({ passkeys, protectedApp }: { passkeys: Passkey[]; protectedApp: boolean }) {
  const router = useRouter()
  const [label, setLabel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, startWork] = useTransition()

  const [supported, setSupported] = useState(false)
  useEffect(() => setSupported(browserSupportsWebAuthn()), [])

  const add = () => {
    setError(null)

    startWork(async () => {
      const begun = await beginPasskeyRegistration()
      if (!begun.ok) {
        setError(begun.error)
        return
      }

      let response
      try {
        response = await startRegistration({ optionsJSON: begun.options })
      } catch (cause) {
        // InvalidStateError is the one worth translating: it means this
        // authenticator is already registered, which the browser reports as a
        // flat failure and nobody would otherwise work out.
        const name = cause instanceof Error ? cause.name : ''
        setError(
          name === 'InvalidStateError'
            ? 'This device already has a passkey for the ledger.'
            : 'Nothing was registered. The prompt was dismissed, or the device declined.',
        )
        return
      }

      const finished = await finishPasskeyRegistration(response, label)
      if (finished.error) {
        setError(finished.error)
        return
      }

      setLabel('')
      router.refresh()
    })
  }

  const forget = (passkey: Passkey) => {
    if (!confirm(`Forget “${passkey.label}”? That device will need the password again.`)) return

    setError(null)

    startWork(async () => {
      const result = await removePasskey(passkey.id)
      if (result.error) setError(result.error)
      else router.refresh()
    })
  }

  return (
    <>
      {passkeys.length === 0 ? (
        <div className="empty">
          <svg className="empty-art" viewBox="0 0 48 48" aria-hidden>
            <circle cx="19" cy="17" r="7.5" />
            <path d="M7 39c0-6 5.4-10.4 12-10.4 2 0 3.9.4 5.5 1.1M34 27a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM34 27v12l3 2.2-3 2" />
          </svg>
          <strong>No passkeys yet</strong>
          Add one on each device you check the ledger from, and signing in becomes a look at your
          phone. The password keeps working either way.
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Device</th>
                <th style={{ width: 150 }}>Added</th>
                <th style={{ width: 160 }}>Last used</th>
                <th style={{ width: 120 }}>Backed up</th>
                <th style={{ width: 90 }} />
              </tr>
            </thead>
            <tbody>
              {passkeys.map((passkey) => (
                <tr key={passkey.id}>
                  <td style={{ fontWeight: 600 }}>{passkey.label}</td>
                  <td style={{ fontSize: 13, color: 'var(--ink-muted)' }}>
                    {instantDate(passkey.createdAt)}
                  </td>
                  <td style={{ fontSize: 13, color: 'var(--ink-muted)' }}>
                    {passkey.lastUsedAt ? instantDate(passkey.lastUsedAt) : 'never'}
                  </td>
                  <td>
                    {passkey.backedUp ? (
                      <span className="tag tag-living">synced</span>
                    ) : (
                      <span className="tag tag-ghost">this device only</span>
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-quiet"
                      onClick={() => forget(passkey)}
                      disabled={busy}
                    >
                      Forget
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {protectedApp && supported && (
        <div className="toolbar" style={{ marginTop: passkeys.length > 0 ? 18 : 0 }}>
          <div className="field">
            <label htmlFor="passkey-label">Call it</label>
            <input
              id="passkey-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="My phone"
              maxLength={60}
            />
          </div>
          <button type="button" className="btn" onClick={add} disabled={busy}>
            {busy ? 'Waiting for the device…' : 'Add a passkey'}
          </button>
        </div>
      )}

      {protectedApp && !supported && (
        <p className="note" style={{ marginTop: 14 }}>
          This browser cannot make passkeys. Open the ledger in Safari, Chrome, or Edge on a device
          with a screen lock.
        </p>
      )}

      {!protectedApp && (
        <p className="note" style={{ marginTop: 14 }}>
          The ledger is open to anyone who can reach it. Set <code>APP_PASSWORD</code> and restart to
          lock it, then add passkeys from here.
        </p>
      )}

      {error && (
        <p className="signin-error" role="alert" style={{ marginTop: 14 }}>
          {error}
        </p>
      )}
    </>
  )
}
