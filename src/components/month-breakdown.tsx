import type { Breakdown, BreakdownBand } from '../lib/queries.ts'
import { money, moneyWhole } from '../lib/format.ts'

/**
 * Everything that left the accounts this month, with each part that is not
 * really spending peeling off in turn, ending in the part that is.
 *
 * The bands are a true partition — they add up to the total exactly — so the
 * spending figure at the bottom is always visibly the remainder of a
 * subtraction rather than a number that arrived from nowhere. That is the whole
 * argument: "$6,200 left your accounts, $4,400 of it was spending" is only
 * believable if every dollar of the difference is named.
 *
 * Money that does not count is drawn hatched rather than merely in a different
 * colour, so the distinction survives being printed, screenshotted, or read by
 * someone who does not see the colours the way this was drawn.
 */

const EXCLUDED = new Set(['passthrough', 'card_payment', 'internal_transfer', 'unidentified'])

function fillFor(band: BreakdownBand): string {
  if (band.key === 'living') return 'var(--bloom)'
  if (band.key === 'non_consumption') return 'var(--iris)'
  return 'repeating-linear-gradient(-45deg, var(--quiet) 0 1.5px, var(--quiet-soft) 1.5px 6px)'
}

export function MonthBreakdown({
  data,
  comparison,
  isCurrent,
}: {
  data: Breakdown
  /** What this month's spending is measured against, and what that average is of. */
  comparison: { average: number; label: string }
  isCurrent: boolean
}) {
  const bands = data.bands
    .filter((band) => band.amount > 0.005)
    .map((band) =>
      band.key === 'living' && isCurrent
        ? { ...band, because: 'Everything you have genuinely paid for so far.' }
        : band,
    )

  const total = bands.reduce((sum, band) => sum + band.amount, 0)
  const delta = comparison.average > 0 ? data.living / comparison.average - 1 : 0
  const over = delta > 0

  return (
    <div className="breakdown">
      <div>
        <div className="eyebrow" style={{ marginBottom: 10 }}>
          {moneyWhole(total)} left your accounts{isCurrent ? ' so far' : ''}
        </div>

        <div className="breakdown-bar" role="img" aria-label={describe(bands, total)}>
          {bands.map((band, i) => (
            <div
              key={band.key}
              className="breakdown-seg"
              style={{
                width: `${(band.amount / total) * 100}%`,
                background: fillFor(band),
                animationDelay: `${i * 70}ms`,
              }}
              title={`${band.label} — ${money(band.amount)}`}
            />
          ))}
        </div>

        <dl className="breakdown-list">
          {bands.map((band) => {
            const result = band.key === 'living'

            return (
              <div
                key={band.key}
                className={`breakdown-row${EXCLUDED.has(band.key) ? ' is-excluded' : ''}${
                  result ? ' is-result' : ''
                }`}
              >
                <span
                  className="breakdown-swatch"
                  style={{ background: fillFor(band) }}
                  aria-hidden
                />
                <dt className="breakdown-label">
                  {band.label}
                  <span className="breakdown-because">{band.because}</span>
                </dt>
                <dd className="breakdown-amount num">
                  {result ? '' : '− '}
                  {money(band.amount)}
                </dd>
              </div>
            )
          })}
        </dl>
      </div>

      <div>
        <div className="panel" style={{ background: 'var(--bloom-soft)' }}>
          <div className="eyebrow">{isCurrent ? 'Spent so far' : 'Spent'}</div>
          <div className="panel-value" style={{ color: 'var(--bloom)' }}>
            {moneyWhole(data.living)}
          </div>

          {comparison.average > 0 && (
            <div className={`panel-delta ${over ? 'delta-over' : 'delta-under'}`}>
              {over ? '▲' : '▼'} {Math.abs(delta * 100).toFixed(0)}% {comparison.label}
              <span className="num" style={{ color: 'var(--ink-faint)', fontWeight: 400 }}>
                {moneyWhole(comparison.average)}
              </span>
            </div>
          )}
        </div>

        <dl className="stat-list" style={{ marginTop: 16 }}>
          <div className="stat-row">
            <dt>Money in</dt>
            <dd>{moneyWhole(data.income)}</dd>
          </div>
          {data.passthroughRetained !== 0 && (
            <div className="stat-row">
              <dt>Kept from money passing through</dt>
              <dd>{moneyWhole(data.passthroughRetained)}</dd>
            </div>
          )}
          <div className="stat-row">
            <dt>Less what you spent</dt>
            <dd>−{moneyWhole(data.living)}</dd>
          </div>
          <div className="stat-row">
            <dt>Less what you put away</dt>
            <dd>−{moneyWhole(capitalOf(data))}</dd>
          </div>
          {/* A month still running is measured against however much pay has
              landed so far, which for anyone paid fortnightly swings between
              looking dire and looking wonderful depending on the day. So while
              it is running this is stated as a running total rather than as a
              verdict; the figure at the top of the page is the one that
              accounts for the pay still to come. */}
          <div className="stat-row is-total">
            <dt>{isCurrent ? 'So far' : netOf(data) >= 0 ? 'Ahead by' : 'Behind by'}</dt>
            <dd style={{ color: netOf(data) >= 0 ? 'var(--jade)' : 'var(--berry)' }}>
              {isCurrent && netOf(data) >= 0 ? '+' : ''}
              {isCurrent ? moneyWhole(netOf(data)) : moneyWhole(Math.abs(netOf(data)))}
            </dd>
          </div>
          {data.unclassified > 0 && (
            <div className="stat-row">
              <dt>Still to sort</dt>
              <dd style={{ color: 'var(--honey)' }}>{moneyWhole(data.unclassified)}</dd>
            </div>
          )}
        </dl>

        {isCurrent && (
          <p className="note" style={{ marginTop: 12 }}>
            This counts only the pay that has landed so far. The figure at the top of the page
            allows for the rest of the month.
          </p>
        )}
      </div>
    </div>
  )
}

/** Savings and investing: it left the account, so a "what's left" figure that
    ignored it would be flattering and wrong. */
function capitalOf(data: Breakdown): number {
  return data.bands.find((band) => band.key === 'non_consumption')?.amount ?? 0
}

function netOf(data: Breakdown): number {
  return data.income + data.passthroughRetained - data.living - capitalOf(data)
}

function describe(bands: BreakdownBand[], total: number): string {
  const parts = bands.map(
    (band) => `${band.label} ${money(band.amount)}, ${Math.round((band.amount / total) * 100)}%`,
  )
  return `Breakdown of ${money(total)} leaving the accounts: ${parts.join('; ')}.`
}
