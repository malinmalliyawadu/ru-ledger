'use client'

import { useEffect, useRef, useState } from 'react'

import type { Outlook } from '../lib/queries.ts'
import { money, moneyWhole, plural } from '../lib/format.ts'

/**
 * The one figure this app exists to answer, and the shape that explains it.
 *
 * Someone on a salary knows almost exactly what is coming in and what is
 * already claimed by rent, power and subscriptions. So the useful question is
 * not "what did I spend last month" — that is history — but "of this month's
 * money, how much is genuinely still mine?"
 *
 * The track underneath is the working. One bar, the whole month's money, in the
 * order it leaves: already spent, already put away, still to be taken by bills,
 * and what is left. The needle marks today, so "three quarters of the money,
 * half of the month" reads as a shape before a single figure has been read.
 */

type Segment = { key: string; label: string; amount: number; className: string; because: string }

export function SafeToSpend({
  outlook,
  monthLabel,
  isCurrent,
  elapsedDays,
  totalDays,
}: {
  outlook: Outlook
  monthLabel: string
  isCurrent: boolean
  elapsedDays: number
  totalDays: number
}) {
  const { spent, saved, billsTotal, safeToSpend, expectedIn } = outlook
  const short = safeToSpend < 0

  const segments: Segment[] = [
    {
      key: 'spent',
      label: 'Spent',
      amount: spent,
      className: 'track-seg-spent',
      because: 'Everything you have actually paid for this month.',
    },
    {
      key: 'saved',
      label: 'Put away',
      amount: saved,
      className: 'track-seg-saved',
      because: 'Savings and investing. It left the account, but you still have it.',
    },
    ...(isCurrent
      ? [
          {
            key: 'bills',
            label: 'Bills still to come',
            amount: billsTotal,
            className: 'track-seg-bills',
            because: 'Regular payments due before the month is out.',
          },
        ]
      : []),
    {
      key: 'free',
      label: isCurrent ? 'Yours to spend' : 'Left over',
      amount: Math.max(0, safeToSpend),
      className: 'track-seg-free',
      because: isCurrent
        ? 'What is left once everything above is accounted for.'
        : 'What the month ended with.',
    },
  ].filter((segment) => segment.amount > 0.005)

  // When the month is overspent the parts add up to more than came in, so the
  // bar is scaled to the parts rather than to the income. A bar that overflowed
  // its own container would simply clip the overspend out of sight, which is
  // the one thing it must never do.
  const total = Math.max(
    expectedIn,
    segments.reduce((sum, segment) => sum + segment.amount, 0),
    1,
  )

  const elapsedShare = totalDays > 0 ? Math.min(1, elapsedDays / totalDays) : 0

  return (
    <section className="hero">
      <div className="hero-top">
        <div className="hero-figure">
          <div className="eyebrow">
            {isCurrent ? 'Yours to spend this month' : `Left over in ${monthLabel}`}
          </div>
          <div className={`hero-value${short ? ' is-negative' : ''}`}>
            <CountUp value={Math.abs(safeToSpend)} />
          </div>
          <p className="hero-sub">
            {isCurrent ? (
              short ? (
                <>
                  This month is <strong>{moneyWhole(Math.abs(safeToSpend))} short</strong> once the
                  bills still to come are counted. Worth a look at what is left below.
                </>
              ) : (
                <>
                  That is <strong>{money(outlook.perDay)} a day</strong> for the{' '}
                  {plural(outlook.daysLeft, 'day')} left, with{' '}
                  <strong>{moneyWhole(billsTotal)}</strong> of bills already set aside.
                </>
              )
            ) : short ? (
              <>
                {monthLabel} spent <strong>{moneyWhole(Math.abs(safeToSpend))} more</strong> than it
                brought in. It happens — the months either side are worth comparing.
              </>
            ) : (
              <>
                {monthLabel} finished ahead by{' '}
                <strong>{moneyWhole(safeToSpend)}</strong>, on top of the{' '}
                {moneyWhole(saved)} you put away.
              </>
            )}
          </p>
        </div>

        <div className="hero-aside">
          <span className="hero-pill">
            {outlook.incomeIsEstimated ? 'Expected in' : 'Money in'} <b>{moneyWhole(expectedIn)}</b>
          </span>
          {outlook.incomeIsEstimated && (
            <span className="note" style={{ maxWidth: '26ch' }}>
              {moneyWhole(outlook.moneyIn)} has landed so far. The rest is your usual month.
            </span>
          )}
        </div>
      </div>

      <div className="track">
        <div
          className="track-bar"
          role="img"
          aria-label={describe(segments, total)}
        >
          {segments.map((segment, i) => (
            <div
              key={segment.key}
              className={`track-seg ${segment.className}`}
              style={{
                width: `${(segment.amount / total) * 100}%`,
                animationDelay: `${i * 90}ms`,
              }}
              title={`${segment.label} — ${money(segment.amount)}`}
            />
          ))}

          {isCurrent && elapsedShare > 0.02 && elapsedShare < 0.98 && (
            <span
              className="track-needle"
              style={{ left: `${elapsedShare * 100}%` }}
              data-label={`day ${elapsedDays}`}
              aria-hidden
            />
          )}
        </div>

        <dl className="track-key">
          {segments.map((segment, i) => (
            <div
              key={segment.key}
              className="track-key-item"
              style={{ '--i': i } as React.CSSProperties}
              title={segment.because}
            >
              <span className={`track-key-dot ${segment.className}`} aria-hidden />
              <dt>{segment.label}</dt>
              <dd>
                <b>{moneyWhole(segment.amount)}</b>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  )
}

function describe(segments: Segment[], total: number): string {
  const parts = segments.map(
    (segment) =>
      `${segment.label} ${money(segment.amount)}, ${Math.round((segment.amount / total) * 100)}%`,
  )
  return `This month's money: ${parts.join('; ')}.`
}

/**
 * Counts the headline up on arrival. It is the one flourish on the page and it
 * lasts under a second, but it does something useful as well as pleasant: the
 * eye lands on the figure that is moving, which is the figure that matters.
 *
 * The final value is rendered on the server and is what a reader without
 * JavaScript, or with reduced motion asked for, sees immediately.
 */
function CountUp({ value }: { value: number }) {
  const [shown, setShown] = useState(value)
  const frame = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(value)
      return
    }

    const start = performance.now()
    const duration = 900

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      // Ease out quart: fast enough to feel responsive, slow enough at the end
      // that the last few hundred dollars are readable rather than a blur.
      setShown(value * (1 - (1 - t) ** 4))
      if (t < 1) frame.current = requestAnimationFrame(tick)
    }

    frame.current = requestAnimationFrame(tick)
    return () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current)
    }
  }, [value])

  return <>{moneyWhole(shown)}</>
}
