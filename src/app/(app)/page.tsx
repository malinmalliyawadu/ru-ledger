import Link from 'next/link'

import { CategoryBars } from '../../components/category-bars.tsx'
import { MonthBreakdown } from '../../components/month-breakdown.tsx'
import { MonthPicker } from '../../components/month-picker.tsx'
import { SafeToSpend } from '../../components/safe-to-spend.tsx'
import { TrendChart } from '../../components/trend-chart.tsx'
import {
  getBreakdown,
  getCategoryTotals,
  getHealth,
  getOutlook,
  getPaceComparison,
  getPeriods,
  getTrend,
} from '../../lib/queries.ts'
import { money, moneyWhole, monthLabel, plural, shortDate } from '../../lib/format.ts'
import { nzHour } from '../../lib/time.ts'

export const dynamic = 'force-dynamic'

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>
}) {
  const { period } = await searchParams
  const periods = await getPeriods()

  if (periods.length === 0) return <FirstRun />

  // Defaults to the month we are living in — but only once it has something in
  // it. Bank data runs a few days behind, so for the first days of every month
  // the current one is genuinely empty, and opening on a blank page is worse
  // than opening on the most recent month that has anything to show.
  const requested = period ? periods.find((p) => p.start === period) : undefined
  const mostRecentWithData = periods.find((p) => p.hasData)
  const active = requested ?? mostRecentWithData ?? periods[0]!
  const selected = active.start

  const current = periods.find((p) => p.isCurrent)
  const waitingOnData =
    !requested && current !== undefined && !current.hasData && !active.isCurrent

  const partial = active.isCurrent && active.elapsedDays < active.totalDays

  const [outlook, breakdown, trend, categories, health, pace] = await Promise.all([
    getOutlook(active.start, active.end, active.isCurrent),
    getBreakdown(selected),
    getTrend(13),
    getCategoryTotals(selected),
    getHealth(),
    partial ? getPaceComparison(selected, active.elapsedDays) : null,
  ])

  // A part-finished month is compared against the same point in earlier months.
  // A finished one is compared against whole months, excluding itself so it is
  // not partly measured against its own value.
  const closed = new Set(periods.filter((p) => !p.isCurrent).map((p) => p.start))
  const others = trend.filter(
    (point) => point.periodStart !== selected && closed.has(point.periodStart),
  )
  const wholeMonthAverage =
    others.length > 0 ? others.reduce((sum, p) => sum + p.living, 0) / others.length : 0

  const comparison = partial
    ? { average: pace!.average, label: `vs your usual by day ${active.elapsedDays}` }
    : { average: wholeMonthAverage, label: 'vs your usual month' }

  const previous = periods.find((p) => p.start < selected && p.hasData)
  const label = monthLabel(active.start, active.end)

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="greeting">
            {greeting()}, <em>Ru</em>
          </h1>
          <p>{active.isCurrent ? `Here is how ${label} is going.` : `Looking back at ${label}.`}</p>
        </div>
        <MonthPicker periods={periods} selected={selected} basePath="/" />
      </div>

      {health.stale.length > 0 && (
        <div className="banner">
          <WarnIcon />
          <div>
            <strong>
              {health.stale.length === 1
                ? `${health.stale[0]!.name} hasn't checked in.`
                : `${health.stale.length} accounts haven't checked in.`}
            </strong>{' '}
            Nothing new has come through from {health.stale.map((a) => a.name).join(', ')} in a
            while, so anything spent since is missing from the figures below.{' '}
            <Link href="/accounts">Have a look</Link>.
          </div>
        </div>
      )}

      {health.drift !== 0 && (
        <div className="banner banner-error">
          <WarnIcon />
          <div>
            <strong>These totals don&rsquo;t add up.</strong> The money that moved is out by{' '}
            <span className="num">{moneyWhole(health.drift)}</span> against the way it has been
            sorted, so something is counted twice or not at all. Worth fixing before trusting this
            page.
          </div>
        </div>
      )}

      {waitingOnData && current && (
        <p className="note">
          Nothing has landed in {monthLabel(current.start, current.end)} yet
          {current.elapsedDays === 1
            ? ', because it started today'
            : `, ${current.elapsedDays} days in`}
          . Banks run a few days behind.{' '}
          <Link href={`/?period=${current.start}`}>Open it anyway</Link>, or carry on below.
        </p>
      )}

      {breakdown.totalOut === 0 ? (
        <section className="card">
          <div className="empty">
            <strong>Nothing in {label}</strong>
            {active.isCurrent && active.elapsedDays === 1
              ? 'It only started today, and banks run a few days behind.'
              : 'No transactions have come through for these dates.'}{' '}
            {previous && (
              <>
                <Link href={`/?period=${previous.start}`}>
                  See {monthLabel(previous.start, previous.end)}
                </Link>{' '}
                instead.
              </>
            )}
          </div>
        </section>
      ) : (
        <SafeToSpend
          outlook={outlook}
          monthLabel={label}
          isCurrent={active.isCurrent}
          elapsedDays={active.elapsedDays}
          totalDays={active.totalDays}
        />
      )}

      {outlook.bills.length > 0 && (
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Still to come this month</h2>
              <p>
                Regular payments due before {label} is out, worked out from when each one has landed
                before. They are already taken off the figure above.
              </p>
            </div>
            <Link href="/recurring" className="btn btn-quiet">
              All bills
            </Link>
          </div>

          <div className="bills">
            {outlook.bills.slice(0, 8).map((bill) => (
              <div key={`${bill.merchant}-${bill.dueOn}`} className="bill">
                <span className="bill-when">
                  <b>{new Date(`${bill.dueOn}T00:00:00Z`).getUTCDate()}</b>
                  <span>{shortDate(bill.dueOn).split(' ')[1]}</span>
                </span>
                <span className="bill-name">
                  <strong>{bill.merchant}</strong>
                  <small>
                    {bill.category ?? 'Uncategorised'} ·{' '}
                    {bill.daysAway === 0
                      ? 'today'
                      : bill.daysAway === 1
                        ? 'tomorrow'
                        : `in ${plural(bill.daysAway, 'day')}`}
                  </small>
                </span>
                <span className="bill-amount">{money(bill.amount)}</span>
              </div>
            ))}
          </div>

          {outlook.bills.length > 8 && (
            <p className="note" style={{ marginTop: 14 }}>
              And {plural(outlook.bills.length - 8, 'more')}, worth{' '}
              <span className="num">
                {money(outlook.bills.slice(8).reduce((sum, bill) => sum + bill.amount, 0))}
              </span>{' '}
              between them.
            </p>
          )}
        </section>
      )}

      {breakdown.totalOut > 0 && (
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Where it actually went</h2>
              <p>
                Not everything that leaves your account is spending. Each part that isn&rsquo;t
                comes off in turn, and what is left at the bottom is the real figure.
              </p>
            </div>
          </div>
          <MonthBreakdown data={breakdown} comparison={comparison} isCurrent={active.isCurrent} />
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <div>
            <h2>Month by month</h2>
            <p>
              What you spent each month. The paler block on top is money you put away — real, but
              saved rather than spent. Select a month to open it.
            </p>
          </div>
        </div>
        {/* Always the whole-month average: the chart's columns are whole months,
            whatever the figure above is comparing. */}
        <TrendChart points={trend} selected={selected} average={wholeMonthAverage} />
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>Your biggest categories</h2>
            <p>
              The tick on each bar is what that category usually costs you in a month. Select one to
              see what is behind it.
            </p>
          </div>
          <Link href="/categories" className="btn btn-quiet">
            See all
          </Link>
        </div>
        <CategoryBars totals={categories.slice(0, 8)} periodStart={selected} />
      </section>
    </>
  )
}

/**
 * Rendered on the server in New Zealand time. The page is force-dynamic, so
 * this is the time when the page was asked for rather than when it was built.
 */
function greeting(): string {
  const hour = nzHour()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

function WarnIcon() {
  return (
    <svg className="banner-icon" viewBox="0 0 24 24" aria-hidden>
      <path d="M12 3.8 21 19.5H3zM12 10v4.4" />
      <circle cx="12" cy="17.2" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  )
}

function FirstRun() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="greeting">
            Welcome, <em>Ru</em>
          </h1>
          <p>
            There is nothing in here yet. Once your accounts are connected, this page will tell you
            what you have spent, what is still coming, and how much of this month is genuinely
            yours.
          </p>
        </div>
      </div>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>Getting started</h2>
            <p>Three commands, and then it runs itself.</p>
          </div>
        </div>
        <ol className="note" style={{ paddingLeft: 20, display: 'grid', gap: 10 }}>
          <li>
            Connect your accounts through Akahu and run <code>npm run backfill</code> to pull your
            history.
          </li>
          <li>
            Run <code>npm run recompute</code> to sort it into categories.
          </li>
          <li>
            Or, to have a look around first:{' '}
            <code>npm run seed:demo &amp;&amp; npm run recompute</code> fills it with a year of
            made-up transactions.
          </li>
        </ol>
      </section>
    </>
  )
}
