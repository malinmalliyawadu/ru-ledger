import Link from 'next/link'

import type { CategoryTotal } from '../lib/queries.ts'
import { money } from '../lib/format.ts'

/**
 * Spending by category, with a tick marking what that category usually costs
 * you in a month. The bar answers "how much"; the tick answers "is that normal
 * for me", which is the question a bare ranking cannot.
 *
 * Categories that are saving rather than spending keep the iris colour, so
 * money you still have is never mistaken for money you spent even when it tops
 * the list.
 */
export function CategoryBars({
  totals,
  periodStart,
  showAverage = true,
  showCapitalTag = true,
}: {
  totals: CategoryTotal[]
  periodStart: string | null
  showAverage?: boolean
  /** Redundant in a list that is already all savings, and it crowds the name. */
  showCapitalTag?: boolean
}) {
  const visible = totals.filter((total) => total.amount > 0)
  if (visible.length === 0) {
    return (
      <div className="empty">
        <EmptyArt />
        <strong>Nothing here yet</strong>
        No spending has been sorted into a category for this month.
      </div>
    )
  }

  const widest = Math.max(
    ...visible.map((t) => Math.max(t.amount, showAverage ? t.averagePerPeriod : 0)),
  )

  return (
    <div>
      {visible.map((total, i) => {
        const href = total.categoryId
          ? `/transactions?category=${total.categoryId}${periodStart ? `&period=${periodStart}` : ''}`
          : '/transactions?unmatched=1'

        return (
          <Link key={total.category} href={href} className="bar-row">
            <span className="bar-name">
              <span>{total.category}</span>
              {!total.isConsumption && showCapitalTag && (
                <span className="tag tag-capital">put away</span>
              )}
            </span>

            <span className="bar-track">
              <span
                className="bar-fill"
                style={{
                  width: `${Math.max(1, (total.amount / widest) * 100)}%`,
                  background: total.isConsumption ? 'var(--bloom)' : 'var(--iris)',
                  animationDelay: `${Math.min(i, 12) * 45}ms`,
                }}
              />
              {showAverage && total.averagePerPeriod > 0 && (
                <span
                  className="bar-tick"
                  style={{ left: `${Math.min(99.5, (total.averagePerPeriod / widest) * 100)}%` }}
                  title={`Usually ${money(total.averagePerPeriod)} a month`}
                />
              )}
            </span>

            <span className="bar-value">{money(total.amount)}</span>
          </Link>
        )
      })}
    </div>
  )
}

function EmptyArt() {
  return (
    <svg className="empty-art" viewBox="0 0 48 48" aria-hidden>
      <circle cx="24" cy="24" r="16" />
      <path d="M24 8v16l11 5" />
    </svg>
  )
}
