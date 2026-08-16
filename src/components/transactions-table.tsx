'use client'

import Link from 'next/link'
import { useOptimistic, useTransition } from 'react'

import { recategorise } from '../app/actions.ts'
import type { TransactionRow } from '../lib/queries.ts'
import { fullDate, money, shortDate, toDate } from '../lib/format.ts'

type Category = { id: string; name: string; kind: 'expense' | 'income'; isConsumption: boolean }

const EXCLUSIONS: { value: string; label: string }[] = [
  { value: 'exclude:card_payment', label: 'Paying off a card' },
  { value: 'exclude:internal_transfer', label: 'Between my own accounts' },
  { value: 'exclude:passthrough', label: 'Passed straight through' },
  { value: 'exclude:unidentified', label: "Can't tell what this is" },
]

export function TransactionsTable({
  rows,
  categories,
  showAccount = true,
}: {
  rows: TransactionRow[]
  categories: Category[]
  showAccount?: boolean
}) {
  if (rows.length === 0) {
    return (
      <div className="empty">
        <svg className="empty-art" viewBox="0 0 48 48" aria-hidden>
          <circle cx="21" cy="21" r="13" />
          <path d="m31 31 9 9" />
        </svg>
        <strong>Nothing matches</strong>
        Try another month, another category, or a different search.
      </div>
    )
  }

  // A list spanning more than one calendar year needs the year on every row;
  // a single period does not, and the extra text only crowds the column.
  const years = new Set(rows.map((row) => toDate(row.date).getUTCFullYear()))
  const showYear = years.size > 1

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th style={{ width: showYear ? 104 : 76 }}>Date</th>
            <th>Description</th>
            {showAccount && <th style={{ width: 150 }}>Account</th>}
            <th style={{ width: 210 }}>Category</th>
            <th className="col-amount" style={{ width: 120 }}>
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Row
              key={row.id}
              row={row}
              categories={categories}
              showAccount={showAccount}
              showYear={showYear}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Row({
  row,
  categories,
  showAccount,
  showYear,
}: {
  row: TransactionRow
  categories: Category[]
  showAccount: boolean
  showYear: boolean
}) {
  const [pending, startTransition] = useTransition()
  const excluded = row.exclusionReason !== null

  // The select is controlled by the server's verdict, but shows the new one the
  // moment it is picked: the write is followed by a revalidation, which is far
  // too long to leave a click looking like it did nothing. When the transition
  // settles, the optimistic value drops and the server's answer takes over —
  // so a rejected verdict corrects itself rather than sticking.
  const [verdict, showVerdict] = useOptimistic(currentValue(row))

  return (
    <tr style={pending ? { opacity: 0.5 } : undefined}>
      <td className="col-num" style={{ textAlign: 'left', fontSize: 12, color: 'var(--ink-muted)' }}>
        {showYear ? fullDate(row.date) : shortDate(row.date)}
      </td>

      <td>
        <span className="desc">
          <strong>{row.merchant ?? row.description}</strong>
          {/* Only show the raw descriptor when it actually says something the
              display name does not. Case alone is not a difference. */}
          {row.merchant && row.merchant.toLowerCase() !== row.description.toLowerCase() && (
            <small>{row.description}</small>
          )}
        </span>
      </td>

      {showAccount && <td style={{ color: 'var(--ink-muted)', fontSize: 12 }}>{row.account}</td>}

      <td>
        {/* Deliberately not a form. React resets an uncontrolled form after a
            form action runs, which put the select back to the verdict it was
            mounted with while the write had already landed — the value only
            looked right again after a reload. */}
        <select
          className="recat"
          aria-label={`Category for ${row.merchant ?? row.description}`}
          value={verdict}
          onChange={(event) => {
            const next = event.target.value
            startTransition(async () => {
              showVerdict(next)
              await recategorise(row.id, next)
            })
          }}
        >
          {/* The select shows where the transaction actually sits, whatever
              put it there. Reverting is only offered when there is an
              override to revert, so the common case reads as a category
              rather than as a description of the machinery. */}
          {row.classifiedBy === 'unmatched' && <option value="rules">Uncategorised</option>}
          {row.classifiedBy === 'override' && <option value="rules">↺ Back to the rules</option>}

          <optgroup label="Spending &amp; saving">
            {categories
              .filter((c) => c.kind === 'expense')
              .map((c) => (
                <option key={c.id} value={`cat:${c.id}`}>
                  {c.name}
                </option>
              ))}
          </optgroup>

          <optgroup label="Income">
            {categories
              .filter((c) => c.kind === 'income')
              .map((c) => (
                <option key={c.id} value={`cat:${c.id}`}>
                  {c.name}
                </option>
              ))}
          </optgroup>

          <optgroup label="Doesn't count as spending">
            {EXCLUSIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            <option value="include">Actually, do count it</option>
          </optgroup>
        </select>

        {/* The select already names the verdict, so the only thing left worth
            marking is that a human, not a rule, chose it. */}
        {row.classifiedBy === 'override' && (
          <span className="tag tag-ghost" style={{ marginLeft: 4 }}>
            edited
          </span>
        )}
      </td>

      <td className="col-amount">
        <span
          className={row.amount > 0 ? 'amount-in' : 'amount-out'}
          style={excluded ? { color: 'var(--ink-faint)' } : undefined}
        >
          {money(row.amount)}
        </span>
      </td>
    </tr>
  )
}

function currentValue(row: TransactionRow): string {
  if (row.categoryId) return `cat:${row.categoryId}`
  if (row.exclusionReason) return `exclude:${row.exclusionReason}`
  return 'rules'
}

export function CategoryLink({ categoryId, children }: { categoryId: string; children: React.ReactNode }) {
  return <Link href={`/transactions?category=${categoryId}`}>{children}</Link>
}
