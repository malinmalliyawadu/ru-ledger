import { MonthPicker } from '../../../components/month-picker.tsx'
import { TransactionsTable } from '../../../components/transactions-table.tsx'
import { getCategories, getLargePurchases, getPeriods, getSettings } from '../../../lib/queries.ts'
import { moneyWhole, plural } from '../../../lib/format.ts'
import { setThreshold } from '../../actions.ts'

export const dynamic = 'force-dynamic'

export default async function BigBuysPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>
}) {
  const { period } = await searchParams
  const [periods, settings, categories] = await Promise.all([
    getPeriods(),
    getSettings(),
    getCategories(),
  ])

  // Opens on every month, because the point of this page is that a handful of
  // decisions across a year explain a surprising slice of the spending — and
  // one month at a time cannot show that.
  const selected = period === undefined || period === 'all' ? null : period
  const { rows, total, shareOfLiving } = await getLargePurchases(
    settings.largePurchaseThreshold,
    selected,
  )

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Big buys</h1>
          <p>
            Everything over {moneyWhole(settings.largePurchaseThreshold)}. These are decisions
            rather than habits, and folding them into a monthly average is exactly how they
            disappear.
          </p>
        </div>
        <MonthPicker periods={periods} selected={selected} basePath="/large" allowAll />
      </div>

      <div className="grid-2">
        <section className="card">
          <div className="eyebrow">Altogether</div>
          <div className="panel-value" style={{ color: 'var(--bloom)', marginTop: 6 }}>
            {moneyWhole(total)}
          </div>
          <p className="note" style={{ marginTop: 12 }}>
            {plural(rows.length, 'purchase')} over {moneyWhole(settings.largePurchaseThreshold)},
            making up <strong>{(shareOfLiving * 100).toFixed(0)}%</strong> of everything you spent
            {selected ? ' that month' : ' across every month'}.
          </p>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <h2>What counts as big</h2>
              <p>Anything at or above this shows up here on its own.</p>
            </div>
          </div>
          <form action={setThreshold} className="toolbar">
            <div className="field">
              <label htmlFor="threshold">NZ$</label>
              <input
                id="threshold"
                name="threshold"
                type="number"
                min="1"
                step="10"
                defaultValue={settings.largePurchaseThreshold}
                style={{ width: 100 }}
              />
            </div>
            <button className="btn" type="submit">
              Save
            </button>
          </form>
        </section>
      </div>

      <TransactionsTable rows={rows} categories={categories} />
    </>
  )
}
