'use client'

import Link from 'next/link'
import { useEffect, useRef } from 'react'

import type { Period } from '../lib/queries.ts'
import { monthLabel, toDate } from '../lib/format.ts'

/**
 * Months, newest on the right, the way a calendar runs.
 *
 * The full month is spelled out above the strip rather than left to be inferred
 * from a highlighted chip, because "Aug" on its own is ambiguous the moment
 * there is more than a year of history and the strip has been scrolled.
 *
 * On a narrow screen thirteen chips do not fit, and the one you are looking at
 * is the newest — which is the one that falls off the right-hand end. So the
 * strip scrolls itself to centre the selected month on mount. Without it, a
 * phone opens on a row of chips that all look inactive.
 */
export function MonthPicker({
  periods,
  selected,
  basePath,
  allowAll = false,
}: {
  periods: Period[]
  selected: string | null
  basePath: string
  allowAll?: boolean
}) {
  const shown = periods.slice(0, 13).reverse()
  const active = periods.find((p) => p.start === selected)

  const strip = useRef<HTMLDivElement>(null)

  // scrollLeft is set directly rather than calling scrollIntoView, which also
  // scrolls every ancestor — including the page, which would land the reader
  // halfway down the dashboard before they had read the top of it.
  //
  // Run once on mount and again once the display face has loaded. Fraunces and
  // Plus Jakarta Sans arrive after first paint, and every chip changes width
  // when they do, so a position measured before then is measured against the
  // fallback font and lands somewhere else entirely.
  useEffect(() => {
    const centre = () => {
      const container = strip.current
      const chip = container?.querySelector<HTMLElement>('[aria-current="true"]')
      if (!container || !chip || container.clientWidth === 0) return
      container.scrollLeft = chip.offsetLeft - (container.clientWidth - chip.offsetWidth) / 2
    }

    const frame = requestAnimationFrame(centre)
    document.fonts?.ready.then(centre).catch(() => {})

    return () => cancelAnimationFrame(frame)
  }, [selected])

  return (
    <div className="months">
      <div className="eyebrow months-label">
        {active ? monthLabel(active.start) : 'Every month'}
      </div>
      <div className="months-strip" role="group" aria-label="Month" ref={strip}>
        {allowAll && (
          <Link
            href={basePath}
            className="month-chip"
            aria-current={selected === null ? 'true' : undefined}
          >
            All
          </Link>
        )}
        {shown.map((period, i) => (
          <Link
            key={period.start}
            href={`${basePath}?period=${period.start}`}
            className="month-chip"
            aria-current={period.start === selected ? 'true' : undefined}
            title={monthLabel(period.start)}
          >
            {chipLabel(period, i === 0)}
          </Link>
        ))}
      </div>
    </div>
  )
}

/**
 * The year is shown only where it changes — on January, and on the oldest chip
 * — so thirteen months read as a timeline rather than a wall of repeated years,
 * and two Augusts a year apart still cannot be confused.
 */
function chipLabel(period: Period, isOldest: boolean): string {
  const start = toDate(period.start)
  const month = new Intl.DateTimeFormat('en-NZ', { month: 'short' }).format(start)
  const showYear = isOldest || start.getUTCMonth() === 0
  return showYear ? `${month} ${String(start.getUTCFullYear()).slice(2)}` : month
}
