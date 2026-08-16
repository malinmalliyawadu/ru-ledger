import type { Metadata, Viewport } from 'next'
import { DM_Mono, Fraunces, Plus_Jakarta_Sans } from 'next/font/google'

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

/**
 * Fonts, colours, and the document - and deliberately nothing else.
 *
 * The navigation lives one level down in `(app)`, because the sign-in page is
 * the one page a stranger can reach and the rail is a summary of the ledger:
 * how many transactions there are, how much is unsorted, how far out of balance
 * it is. None of that is anyone else's business.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-NZ" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  )
}
