import Link from 'next/link'

import { BudgetBars } from '../../components/budget-bars.tsx'
import { BudgetEditor } from '../../components/budget-editor.tsx'
import { MonthPicker } from '../../components/month-picker.tsx'
import { suggestedAmount, verdictFor } from '../../lib/budget.ts'
import { getBudget, getPeriods } from '../../lib/queries.ts'
import { money, moneyWhole, monthLabel, plural } from '../../lib/format.ts'

export const dynamic = 'force-dynamic'

export default async function BudgetPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>
}) {
  const { period } = await searchParams
  const periods = await getPeriods()

  if (periods.length === 0) {
    return (
      <div className="page-head">
        <div>
          <h1>Nothing to budget yet</h1>
          <p>
            A budget is set against categories, and there is no spending to sort into them. Connect
            an account, or load a year of made-up transactions with{' '}
            <code>npm run seed:demo &amp;&amp; npm run recompute</code>.
          </p>
        </div>
      </div>
    )
  }

  // Unlike the dashboard, this opens on the month we are living in even when
  // nothing has landed in it. A budget for a month that has not started
  // spending yet is the most useful thing on this page, not an empty one.
  const requested = period ? periods.find((p) => p.start === period) : undefined
  const active = requested ?? periods.find((p) => p.isCurrent) ?? periods[0]!

  const partial = active.isCurrent && active.elapsedDays < active.totalDays
  const budget = await getBudget(active.start, active.elapsedDays, active.totalDays)

  const suggestions = new Map(
    budget.lines
      .map((line) => [line.categoryId, suggestedAmount(line.averagePerPeriod) ?? 0] as const)
      .filter(([, amount]) => amount > 0),
  )

  const remaining = budget.total - budget.spent
  const verdict = verdictFor(
    { budget: budget.total, spent: budget.spent, expectedByNow: budget.expectedByNow },
    partial,
  )
  const over = verdict.tone === 'over'
  const label = monthLabel(active.start, active.end)

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Budget</h1>
          <p>
            What you meant each category to cost, against what it actually did. Set it once and it
            carries forward, so every month is judged against the figure that was in force while it
            was running.
          </p>
        </div>
        <MonthPicker periods={periods} selected={active.start} basePath="/budget" />
      </div>

      {budget.exists ? (
        <section className="card">
          <div className="budget-summary">
            <div>
              <div className="eyebrow" style={{ marginBottom: 12 }}>
                {plural(budget.budgeted.length, 'category', 'categories')} with a limit
              </div>
              <BudgetBars lines={budget.budgeted} periodStart={active.start} partial={partial} />
            </div>

            <div>
              <div className={`panel${over ? ' is-over' : ''}`}>
                <div className="eyebrow">{over ? 'Over budget by' : 'Left in the budget'}</div>
                <div className="panel-value">{moneyWhole(Math.abs(remaining))}</div>

                {partial && (
                  <>
                    <div className="progress" aria-hidden>
                      <span
                        className="progress-fill"
                        style={{ width: `${(active.elapsedDays / active.totalDays) * 100}%` }}
                      />
                    </div>
                    <div className="panel-note">
                      Day {active.elapsedDays} of {active.totalDays}. By now,{' '}
                      {moneyWhole(budget.expectedByNow)} would be normal.
                    </div>
                  </>
                )}

                <div className={`panel-delta ${over ? 'delta-over' : 'delta-under'}`}>
                  {over ? '▲' : '▼'} {verdict.label}
                </div>
              </div>

              <dl className="stat-list" style={{ marginTop: 16 }}>
                <div className="stat-row">
                  <dt>Budgeted</dt>
                  <dd>{moneyWhole(budget.total)}</dd>
                </div>
                <div className="stat-row">
                  <dt>Spent against it</dt>
                  <dd>−{moneyWhole(budget.spent)}</dd>
                </div>
                <div className="stat-row is-total">
                  <dt>{over ? 'Overspent' : 'Remaining'}</dt>
                  <dd style={{ color: over ? 'var(--berry)' : 'var(--jade)' }}>
                    {moneyWhole(remaining)}
                  </dd>
                </div>
                {budget.unbudgetedSpent > 0 && (
                  <div className="stat-row">
                    <dt>Spent outside the budget</dt>
                    <dd style={{ color: 'var(--honey)' }}>{moneyWhole(budget.unbudgetedSpent)}</dd>
                  </div>
                )}
              </dl>
            </div>
          </div>
        </section>
      ) : (
        <section className="card">
          <div className="card-head">
            <div>
              <h2>No budget for {label} yet</h2>
              <p>
                Set a limit on any category and it applies from this month onwards. Each box is
                already showing what that category has actually been costing you, so the quickest
                start is to fill them all in and then argue with the two or three that are wrong.
              </p>
            </div>
          </div>

          <BudgetEditor
            lines={budget.lines}
            periodStart={active.start}
            periodEnd={active.end}
            suggestions={suggestions}
          />
        </section>
      )}

      {budget.exists && budget.unbudgeted.length > 0 && (
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Spent outside the budget</h2>
              <p>
                {moneyWhole(budget.unbudgetedSpent)} in{' '}
                {plural(budget.unbudgeted.length, 'category', 'categories')} with no limit set. A
                budget that covers most of the spending and none of the surprises is the usual way
                one turns out to be wrong, so these are listed rather than quietly left out.
              </p>
            </div>
          </div>

          <ul className="budget-loose">
            {budget.unbudgeted.map((line) => (
              <li key={line.categoryId}>
                <Link href={`/transactions?category=${line.categoryId}&period=${active.start}`}>
                  {line.category}
                </Link>
                <span className="num">{money(line.spent)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {budget.exists && (
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Change the budget</h2>
              <p>
                Changes apply from {label} onwards. To correct what an earlier month was judged
                against, pick that month above first.
              </p>
            </div>
          </div>

          <BudgetEditor
            lines={budget.lines}
            periodStart={active.start}
            periodEnd={active.end}
            suggestions={suggestions}
          />
        </section>
      )}
    </>
  )
}
