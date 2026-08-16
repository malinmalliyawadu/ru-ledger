import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import { SignIn } from '../../components/sign-in.tsx'
import { SESSION_COOKIE, isProtected, isValidSession, safeNext } from '../../lib/auth.ts'
import { hasPasskeys } from '../../lib/webauthn.ts'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: "Unlock - Ru's Ledger",
  // Nothing here is worth indexing, and the ledger behind it certainly is not.
  robots: { index: false, follow: false },
}

/**
 * The only page a stranger can reach.
 *
 * It sits outside the (app) group on purpose, so the rail - which is a summary
 * of the ledger, down to how far out of balance it is - never renders for
 * someone who has not proved they belong here.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  if (!isProtected()) redirect('/')

  const { next } = await searchParams
  const destination = safeNext(next)

  const store = await cookies()
  if (await isValidSession(store.get(SESSION_COOKIE)?.value)) redirect(destination)

  // Whether to offer the passkey button at all. A database that is down should
  // leave you looking at a password field, not an error: the password is the
  // way back in precisely when things are broken.
  const passkeys = await hasPasskeys().catch(() => false)

  return <SignIn next={destination} hasPasskeys={passkeys} />
}
