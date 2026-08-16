import { MonthPicker } from '../../../components/month-picker.tsx'
import { TransactionsTable } from '../../../components/transactions-table.tsx'
import { getCategories, getPeriods, getTransactions } from '../../../lib/queries.ts'
import { money, plural } from '../../../lib/format.ts'

export const dynamic = 'force-dynamic'

export default async function EverythingPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; category?: string; q?: string; unmatched?: string }>
}) {
  const params = await searchParams
  const periods = await getPeriods()
  const selected =
    params.period === undefined ? null : params.period === 'all' ? null : params.period

  const [rows, categories] = await Promise.all([
    getTransactions({
      periodStart: selected,
      categoryId: params.category ?? null,
      search: params.q ?? null,
      onlyUnmatched: params.unmatched === '1',
      limit: 400,
    }),
    getCategories(),
  ])

  const activeCategory = categories.find((c) => c.id === params.category)
  const total = rows.filter((r) => r.countsAsSpend).reduce((sum, r) => sum + Math.abs(r.amount), 0)
  const filtered = Boolean(params.q || params.category || params.unmatched)

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Everything</h1>
          <p>
            Every transaction, and the category it landed in. Change one and it sticks — your answer
            beats the rules from then on, and a row you have edited offers a way back if you change
            your mind.
          </p>
        </div>
        <MonthPicker periods={periods} selected={selected} basePath="/transactions" allowAll />
      </div>

      <form className="toolbar">
        {selected && <input type="hidden" name="period" value={selected} />}
        {params.category && <input type="hidden" name="category" value={params.category} />}
        <div className="field">
          <label htmlFor="q">Find</label>
          <input
            id="q"
            name="q"
            defaultValue={params.q ?? ''}
            placeholder="A shop, a bill, anything"
          />
        </div>
        <button className="btn" type="submit">
          Search
        </button>
        <a
          className="btn btn-quiet"
          href={`/transactions?unmatched=1${selected ? `&period=${selected}` : ''}`}
        >
          Still to sort
        </a>
        {filtered && (
          <a className="btn btn-quiet" href="/transactions">
            Clear
          </a>
        )}

        <span className="note" style={{ marginLeft: 'auto' }}>
          {plural(rows.length, 'transaction')}
          {activeCategory ? ` in ${activeCategory.name}` : ''} · {money(total)} of spending among
          them
        </span>
      </form>

      <TransactionsTable rows={rows} categories={categories} />
    </>
  )
}
