'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { signOut } from '../app/auth-actions.ts'
import type { Health } from '../lib/queries.ts'
import { moneyWhole } from '../lib/format.ts'

/**
 * Two navigations for two hands.
 *
 * On a laptop the rail is a list, because there is room for one and reading
 * down it is faster than reading across. On a phone it becomes a fixed row of
 * five thumb-sized tabs, because a row of seven links that scrolls sideways is
 * a desktop nav wearing a costume: the last two items are invisible, and
 * nothing tells you they are there.
 *
 * The five tabs are the five questions worth asking on a phone. Big buys and
 * Accounts are settling-in tasks rather than daily ones, so they keep their own
 * icons in the top bar instead of taking a tab each.
 */

type Item = { href: string; label: string; short: string; icon: keyof typeof ICONS }

const PRIMARY: Item[] = [
  { href: '/', label: 'Home', short: 'Home', icon: 'home' },
  { href: '/categories', label: 'Spending', short: 'Spending', icon: 'donut' },
  { href: '/budget', label: 'Budget', short: 'Budget', icon: 'target' },
  { href: '/recurring', label: 'Bills', short: 'Bills', icon: 'repeat' },
  { href: '/transactions', label: 'Everything', short: 'Search', icon: 'list' },
]

const SECONDARY: Item[] = [
  { href: '/large', label: 'Big buys', short: 'Big buys', icon: 'sparkle' },
  { href: '/accounts', label: 'Accounts & setup', short: 'Accounts', icon: 'bank' },
]

const ICONS = {
  home: <path d="M3 10.2 12 3l9 7.2M5.5 8.6V20h13V8.6M9.8 20v-5.6h4.4V20" />,
  donut: (
    <>
      <circle cx="12" cy="12" r="8.4" />
      <circle cx="12" cy="12" r="3.4" />
      <path d="M12 3.6v5M18 8.2l-3.6 2.6" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8.4" />
      <circle cx="12" cy="12" r="4.4" />
      <circle cx="12" cy="12" r="0.6" />
    </>
  ),
  repeat: <path d="M4 8h11.5a3.5 3.5 0 0 1 0 7H12m8-7-3-3m3 3-3 3M20 16H8.5a3.5 3.5 0 0 1 0-7H12" />,
  list: (
    <>
      <path d="M4 7h11M4 12h16M4 17h8" />
      <circle cx="18.5" cy="17" r="2.6" />
      <path d="m20.6 19.1 1.4 1.4" />
    </>
  ),
  sparkle: (
    <path d="M12 3.5 13.9 9l5.6 1.9-5.6 1.9L12 18.4l-1.9-5.6L4.5 10.9 10.1 9zM18.5 16l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />
  ),
  bank: (
    <>
      <path d="M3.5 9.4 12 4.5l8.5 4.9M5 10.6v7.9M10 10.6v7.9M14 10.6v7.9M19 10.6v7.9M3.2 19.5h17.6" />
    </>
  ),
} as const

function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg className="rail-icon" viewBox="0 0 24 24" aria-hidden>
      {ICONS[name]}
    </svg>
  )
}

function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname.startsWith(href)
}

export function Rail({ health, canSignOut }: { health: Health | null; canSignOut: boolean }) {
  const pathname = usePathname()
  const needsAttention = health ? Math.round(health.transactions * (1 - health.coverage)) : 0

  return (
    <nav className="rail" aria-label="Sections">
      <Link href="/" className="rail-brand">
        <span className="rail-mark" aria-hidden>
          R
        </span>
        <span className="rail-wordmark">
          <strong>Ru&rsquo;s Ledger</strong>
          <span>Aotearoa</span>
        </span>
      </Link>

      <div className="rail-nav">
        {PRIMARY.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="rail-link"
            aria-current={isActive(pathname, item.href) ? 'page' : undefined}
          >
            <Icon name={item.icon} />
            {item.label}
            {item.href === '/transactions' && needsAttention > 0 && (
              <span className="rail-badge" title={`${needsAttention} still to sort`}>
                {needsAttention}
              </span>
            )}
          </Link>
        ))}

        <div className="rail-group eyebrow">Setting up</div>

        {SECONDARY.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="rail-link"
            aria-current={isActive(pathname, item.href) ? 'page' : undefined}
          >
            <Icon name={item.icon} />
            {item.label}
          </Link>
        ))}
      </div>

      {/* The same two links, for the phone top bar, where the rail's list is
          hidden and the tabs below have no room for them. Sign out joins them
          there for the same reason: the foot it lives in on a laptop is one of
          the things the phone layout hides. */}
      <div className="rail-quick">
        {SECONDARY.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="rail-quick-link"
            aria-label={item.label}
            aria-current={isActive(pathname, item.href) ? 'page' : undefined}
          >
            <Icon name={item.icon} />
          </Link>
        ))}

        {canSignOut && (
          <form action={signOut}>
            <button type="submit" className="rail-quick-link" aria-label="Sign out">
              <svg className="rail-icon" viewBox="0 0 24 24" aria-hidden>
                <path d="M14.5 4.5h4a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-4M10 8l-4 4 4 4M6 12h9" />
              </svg>
            </button>
          </form>
        )}
      </div>

      {(health || canSignOut) && (
        <div className="rail-foot">
          {health && (
            <>
              <div>
                <strong>{health.transactions.toLocaleString('en-NZ')}</strong> transactions,{' '}
                <strong>{(health.coverage * 100).toFixed(0)}%</strong> sorted
              </div>
              <div>
                {health.drift === 0 ? (
                  <>Every dollar accounted for.</>
                ) : (
                  <span style={{ color: 'var(--berry)' }}>
                    Out by <span className="num">{moneyWhole(health.drift)}</span>
                  </span>
                )}
              </div>
            </>
          )}

          {canSignOut && (
            <form action={signOut}>
              <button type="submit" className="rail-signout">
                Sign out
              </button>
            </form>
          )}
        </div>
      )}
    </nav>
  )
}

export function TabBar() {
  const pathname = usePathname()

  return (
    <nav className="tabbar" aria-label="Sections">
      {PRIMARY.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className="tab"
          aria-current={isActive(pathname, item.href) ? 'page' : undefined}
        >
          <Icon name={item.icon} />
          {item.short}
        </Link>
      ))}
    </nav>
  )
}
