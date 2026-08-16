import Link from 'next/link'

import { getRecurring } from '../../../lib/queries.ts'
import { fullDate, money, plural } from '../../../lib/format.ts'

export const dynamic = 'force-dynamic'

const CADENCE: [number, number, string][] = [
  [5, 9, 'Weekly'],
  [11, 17, 'Fortnightly'],
  [26, 35, 'Monthly'],
  [80, 100, 'Every 3 months'],
  [350, 380, 'Yearly'],
]

function cadenceLabel(days: number): string {
  return CADENCE.find(([lo, hi]) => days >= lo && days <= hi)?.[2] ?? `Every ${days} days`
}

export default async function BillsPage() {
  const rows = await getRecurring()
  const overdue = rows.filter((row) => row.possiblyCancelled)
  const live = rows.filter((row) => !row.possiblyCancelled)

  const monthlyTotal = live.reduce((sum, row) => sum + row.monthlyEquivalent, 0)
  // Savings and investing charge on a rhythm too, and they dwarf the small
  // stuff. Rolling them into one figure would make it read as a subscriptions
  // total when most of it is money you are keeping.
  const putAwayMonthly = live
    .filter((row) => !row.isConsumption)
    .reduce((sum, row) => sum + row.monthlyEquivalent, 0)
  const billsMonthly = monthlyTotal - putAwayMonthly

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Bills</h1>
          <p>
            Anything that charges you on a rhythm. Your bank does not label these — the rhythm is
            worked out from the gaps between charges, so a bill that has quietly changed cadence
            shows up rather than hiding.
          </p>
        </div>
        <div className="panel" style={{ minWidth: 250 }}>
          <div className="eyebrow">Committed every month</div>
          <div className="panel-value" style={{ fontSize: 34 }}>
            {money(billsMonthly)}
          </div>
          <div className="panel-note">
            across {plural(live.length, 'regular charge')}.
            {putAwayMonthly > 0 && (
              <>
                {' '}
                Another <strong className="num">{money(putAwayMonthly)}</strong> a month goes into
                savings.
              </>
            )}
          </div>
        </div>
      </div>

      {overdue.length > 0 && (
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Have these stopped?</h2>
              <p>
                Each of these is more than twice its own interval overdue. Either it was cancelled,
                or it is about to surprise you.
              </p>
            </div>
          </div>
          <BillsTable rows={overdue} highlight />
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <div>
            <h2>Charging on schedule</h2>
            <p>Ordered by what each one costs you per month.</p>
          </div>
        </div>
        <BillsTable rows={live} />
      </section>
    </>
  )
}

function BillsTable({
  rows,
  highlight = false,
}: {
  rows: Awaited<ReturnType<typeof getRecurring>>
  highlight?: boolean
}) {
  if (rows.length === 0) {
    return (
      <div className="empty">
        <svg className="empty-art" viewBox="0 0 48 48" aria-hidden>
          <path d="M8 16h24a7 7 0 0 1 0 14H24m16-14-6-6m6 6-6 6M40 32H16a7 7 0 0 1 0-14h8" />
        </svg>
        <strong>Nothing spotted yet</strong>
        A merchant needs at least three charges at a steady interval before it counts as a bill.
      </div>
    )
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>What</th>
            <th style={{ width: 150 }}>How often</th>
            <th style={{ width: 180 }}>Last charged</th>
            <th className="col-amount" style={{ width: 110 }}>
              Usually
            </th>
            <th className="col-amount" style={{ width: 130 }}>
              Per month
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.merchant}>
              <td>
                <Link
                  href={`/transactions?q=${encodeURIComponent(row.merchant)}`}
                  style={{ textDecoration: 'none', fontWeight: 600 }}
                >
                  {row.merchant}
                </Link>
                {row.isPayg && (
                  <span className="tag tag-ghost" style={{ marginLeft: 6 }}>
                    pay as you go
                  </span>
                )}
                {row.category && (
                  <div style={{ fontSize: 12, color: 'var(--ink-faint)' }}>{row.category}</div>
                )}
              </td>
              <td>
                {cadenceLabel(row.cadenceDays)}
                <div style={{ fontSize: 12, color: 'var(--ink-faint)' }}>
                  {plural(row.chargeCount, 'charge')} seen
                </div>
              </td>
              <td>
                <span style={{ fontSize: 13 }}>{fullDate(row.lastCharged)}</span>
                <div
                  style={{
                    fontSize: 12,
                    color: highlight ? 'var(--honey)' : 'var(--ink-faint)',
                    fontWeight: highlight ? 600 : 400,
                  }}
                >
                  {plural(row.daysSinceLast, 'day')} ago
                  {highlight &&
                    ` — ${Math.round(row.daysSinceLast / row.cadenceDays)}× its usual gap`}
                </div>
              </td>
              <td className="col-num">{money(row.averageAmount)}</td>
              <td className="col-num" style={{ fontWeight: 600 }}>
                {money(row.monthlyEquivalent)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
