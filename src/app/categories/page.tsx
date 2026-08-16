import Link from 'next/link'

import { CategoryBars } from '../../components/category-bars.tsx'
import { MonthPicker } from '../../components/month-picker.tsx'
import { getCategoryTotals, getPeriods } from '../../lib/queries.ts'
import { money, monthLabel, plural } from '../../lib/format.ts'

export const dynamic = 'force-dynamic'

export default async function SpendingPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>
}) {
  const { period } = await searchParams
  const periods = await getPeriods()
  const selected =
    period === undefined ? (periods[0]?.start ?? null) : period === 'all' ? null : period

  const totals = await getCategoryTotals(selected)
  const spending = totals.filter((t) => t.isConsumption)
  const putAway = totals.filter((t) => !t.isConsumption)

  const spendingTotal = spending.reduce((sum, t) => sum + t.amount, 0)
  const putAwayTotal = putAway.reduce((sum, t) => sum + t.amount, 0)

  const active = periods.find((p) => p.start === selected)
  const biggest = spending[0]

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Spending</h1>
          <p>
            {biggest
              ? `${biggest.category} is your biggest category${
                  active ? ` in ${monthLabel(active.start, active.end)}` : ''
                }, at ${money(biggest.amount)}.`
              : 'Every category, biggest first. Select one to see what is behind it.'}
          </p>
        </div>
        <MonthPicker periods={periods} selected={selected} basePath="/categories" allowAll />
      </div>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>What you spent it on</h2>
            <p>
              {money(spendingTotal)} across {plural(spending.length, 'category', 'categories')}.
              {selected !== null && ' The tick is what that category usually costs you.'}
            </p>
          </div>
          <Link href="/large" className="btn btn-quiet">
            Big buys
          </Link>
        </div>
        {/* The tick compares one month against a monthly average, so it only
            means something when a single month is in view. */}
        <CategoryBars totals={spending} periodStart={selected} showAverage={selected !== null} />
      </section>

      {putAway.length > 0 && (
        <section className="card">
          <div className="card-head">
            <div>
              <h2>What you put away</h2>
              <p>
                {money(putAwayTotal)} into savings, investing and money sent on. It really left your
                account — but you still have it, so it sits outside the spending figure rather than
                inside it.
              </p>
            </div>
          </div>
          <CategoryBars
            totals={putAway}
            periodStart={selected}
            showAverage={selected !== null}
            showCapitalTag={false}
          />
        </section>
      )}
    </>
  )
}
