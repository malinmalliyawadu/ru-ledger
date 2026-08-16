'use client'

import { useActionState, useEffect, useState, useTransition } from 'react'
import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser'

import {
  beginPasskeySignIn,
  finishPasskeySignIn,
  signIn,
  type SignInState,
} from '../app/auth-actions.ts'

const INITIAL: SignInState = { error: null }

/**
 * The front door.
 *
 * Passkey first, because that is the one you use every day: a look at the phone
 * and you are in. The password is underneath, folded away, because it is the
 * recovery path - the thing you need on a borrowed laptop, or when the phone
 * with the passkey on it is gone.
 *
 * The passkey button only appears when there is a passkey to offer and a
 * browser that can use one. A button that opens a system prompt with nothing in
 * it is worse than no button.
 */
export function SignIn({ next, hasPasskeys }: { next: string; hasPasskeys: boolean }) {
  const [state, submit, submitting] = useActionState(signIn, INITIAL)
  const [passkeyError, setPasskeyError] = useState<string | null>(null)
  const [prompting, startPrompt] = useTransition()

  // Support is a browser fact, so it can only be known after mount. Rendering
  // the button on the server and removing it in the client would flash it.
  const [supported, setSupported] = useState(false)
  useEffect(() => setSupported(browserSupportsWebAuthn()), [])

  const offerPasskey = hasPasskeys && supported
  const [showPassword, setShowPassword] = useState(false)

  const usePasskey = () => {
    setPasskeyError(null)

    startPrompt(async () => {
      const begun = await beginPasskeySignIn()
      if (!begun.ok) {
        setPasskeyError(begun.error)
        return
      }

      let response
      try {
        response = await startAuthentication({ optionsJSON: begun.options })
      } catch {
        // Cancelling is a decision, not a failure. Anything else that lands
        // here - no matching passkey, a dismissed prompt - reads the same way
        // to the person in front of it: nothing happened, try again.
        setPasskeyError('No passkey was used. Try again, or use the password.')
        return
      }

      // Succeeds by redirecting, so anything that comes back is a refusal.
      const finished = await finishPasskeySignIn(response, next)
      if (finished?.error) setPasskeyError(finished.error)
    })
  }

  return (
    <div className="signin">
      <div className="signin-card">
        <div className="signin-brand">
          <span className="rail-mark" aria-hidden>
            R
          </span>
          <div>
            <h1>Ru&rsquo;s Ledger</h1>
            <p>Where your money actually goes.</p>
          </div>
        </div>

        {offerPasskey && (
          <>
            <button type="button" className="btn signin-passkey" onClick={usePasskey} disabled={prompting}>
              <svg viewBox="0 0 24 24" className="rail-icon" aria-hidden>
                <circle cx="9.5" cy="8.2" r="3.7" />
                <path d="M3.4 19.6c0-3 2.7-5.2 6.1-5.2 1 0 2 .2 2.8.6M17 13.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2zM17 13.6V20l1.6 1.2-1.6 1" />
              </svg>
              {prompting ? 'Waiting for your passkey…' : 'Unlock with a passkey'}
            </button>

            {passkeyError && (
              <p className="signin-error" role="alert">
                {passkeyError}
              </p>
            )}
          </>
        )}

        {offerPasskey && !showPassword ? (
          <button type="button" className="signin-switch" onClick={() => setShowPassword(true)}>
            Use the password instead
          </button>
        ) : (
          <form action={submit} className="signin-form">
            <input type="hidden" name="next" value={next} />

            <div className="field signin-field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                autoFocus={!offerPasskey}
                required
              />
            </div>

            <button type="submit" className={offerPasskey ? 'btn btn-quiet' : 'btn'} disabled={submitting}>
              {submitting ? 'Checking…' : 'Unlock'}
            </button>

            {state.error && (
              <p className="signin-error" role="alert">
                {state.error}
              </p>
            )}
          </form>
        )}

        <p className="signin-foot">
          {offerPasskey
            ? 'Passkeys are registered from Accounts & setup, once you are in.'
            : 'Add a passkey from Accounts & setup once you are in, and this becomes a glance at your phone.'}
        </p>
      </div>
    </div>
  )
}
