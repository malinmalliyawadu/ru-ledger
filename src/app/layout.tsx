import type { Metadata, Viewport } from 'next'
import { DM_Mono, Fraunces, Plus_Jakarta_Sans } from 'next/font/google'

import { Rail, TabBar } from '../components/nav.tsx'
import { getHealth } from '../lib/queries.ts'
import './globals.css'

// Fraunces carries all of the personality and is spent only on headings and the
// one figure that matters. Plus Jakarta Sans does every bit of the reading. DM
// Mono lines up columns of currency and nothing else.
const display = Fraunces({
  subsets: ['latin'],
  weight: ['600', '700'],
  style: ['normal', 'italic'],
  variable: '--font-display',
  display: 'swap',
})

const body = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-body',
  display: 'swap',
})

const mono = DM_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  title: "Ru's Ledger",
  description: 'Where your money actually goes, and how much of it is still yours to spend.',
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fff8f5' },
    { media: '(prefers-color-scheme: dark)', color: '#171013' },
  ],
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The layout renders on every page, including before the database has ever
  // been reachable. A failed health check must not be the thing that stops the
  // app rendering the page that would explain why.
  const health = await getHealth().catch(() => null)

  return (
    <html lang="en-NZ" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <div className="shell">
          <Rail health={health} />
          <main className="main">{children}</main>
        </div>
        <TabBar />
      </body>
    </html>
  )
}
