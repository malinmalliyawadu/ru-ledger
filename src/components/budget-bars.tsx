import Link from 'next/link'

import type { BudgetLine } from '../lib/queries.ts'
import { usedShare, verdictFor } from '../lib/budget.ts'
import { money, moneyWhole } from '../lib/format.ts'

/**
 * Each budgeted category as a bar against its own limit.
 *
 * The bar is coloured by how it is going rather than by what it is, because the
 * question here is not "where did it go" — the spending page answers that — but
 * "is this one going wrong". While the month is still running there is a second
 * mark on the track, at the point the budget has reached by today, so a bar two
 * thirds full on day five reads as a problem rather than as progress.
 */

const FILL: Record<string, string> = {
  over: 'var(--berry)',
  ahead: 'var(--honey)',
  'on-track': 'var(--jade)',
  under: 'var(--jade)',
  unused: 'var(--quiet)',
}

export function BudgetBars({
  lines,
  periodStart,
  partial,
}: {
  lines: BudgetLine[]
  periodStart: string
  /** The month is still running, so pace is worth measuring. */
  partial: boolean
}) {
  return (
    <div>
      {lines.map((line, i) => {
        const budget = line.budget ?? 0
        const verdict = verdictFor(
          { budget, spent: line.spent, expectedByNow: line.expectedByNow },
          partial,
        )
        const paceLeft = budget > 0 ? Math.min(99.5, (line.expectedByNow / budget) * 100) : 0

        return (
          <Link
            key={line.categoryId}
            href={`/transactions?category=${line.categoryId}&period=${periodStart}`}
            className="bar-row budget-row"
          >
            <span className="bar-name">
              <span>{line.category}</span>
              {!line.isConsumption && <span className="tag tag-capital">put away</span>}
            </span>

            <span className="bar-track">
              <span
                className="bar-fill"
                style={{
                  width: `${usedShare(line.spent, budget) * 100}%`,
                  background: FILL[verdict.tone],
                  animationDelay: `${Math.min(i, 12) * 45}ms`,
                }}
              />
              {partial && budget > 0 && (
                <span
                  className="bar-tick"
                  style={{ left: `${paceLeft}%` }}
                  title={`${moneyWhole(line.expectedByNow)} would be normal by today`}
                />
              )}
            </span>

            <span className="budget-figures">
              <span className="num">{money(line.spent)}</span>
              <small>of {moneyWhole(budget)}</small>
            </span>

            <span className="budget-verdict">
              <span className={`tag ${verdict.tag}`}>{verdict.label}</span>
            </span>
          </Link>
        )
      })}
    </div>
  )
}
