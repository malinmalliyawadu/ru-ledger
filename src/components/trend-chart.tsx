import Link from 'next/link'

import type { TrendPoint } from '../lib/queries.ts'
import { money, moneyWhole, monthTick } from '../lib/format.ts'

/**
 * Spending per month, with savings and investing stacked above it in the iris
 * colour so the two are comparable without being conflated. The dashed rule is
 * the average of the months shown.
 *
 * Plain SVG: twelve columns and a line do not justify a charting library.
 */

const W = 760
const H = 220
// The right gutter exists so the average label has somewhere to sit that is not
// on top of the last column.
const PAD = { top: 16, right: 68, bottom: 28, left: 54 }

export function TrendChart({
  points,
  selected,
  average,
  showCapital = true,
}: {
  points: TrendPoint[]
  selected?: string
  /** Passed in so the rule here and the figure beside it cannot disagree. */
  average: number
  showCapital?: boolean
}) {
  if (points.length === 0) return null

  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom

  const tallest = Math.max(
    ...points.map((p) => p.living + (showCapital ? p.nonConsumption : 0)),
    1,
  )
  const ceiling = niceCeiling(tallest)

  const slot = plotW / points.length
  const barW = Math.min(36, slot * 0.6)
  const y = (value: number) => PAD.top + plotH - (value / ceiling) * plotH

  return (
    <svg
      className="chart"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`Spending by month. Average ${money(average)}.`}
    >
      {[0, 0.5, 1].map((fraction) => (
        <g key={fraction}>
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={y(ceiling * fraction)}
            y2={y(ceiling * fraction)}
            stroke="var(--line)"
          />
          <text
            className="chart-axis"
            x={PAD.left - 10}
            y={y(ceiling * fraction) + 4}
            textAnchor="end"
          >
            {fraction === 0 ? '0' : compact(ceiling * fraction)}
          </text>
        </g>
      ))}

      {points.map((point, i) => {
        const x = PAD.left + slot * i + (slot - barW) / 2
        const isSelected = point.periodStart === selected
        const capitalH = showCapital ? plotH - (y(point.nonConsumption) - PAD.top) : 0
        const livingH = plotH - (y(point.living) - PAD.top)

        // One string, not two children: adjacent text nodes inside an SVG
        // <title> serialise differently on the server and the client, which
        // React reports as a hydration mismatch.
        const tooltip =
          `${monthTick(point.periodStart)} — spent ${money(point.living)}` +
          (showCapital ? `, put away ${money(point.nonConsumption)}` : '')

        return (
          <Link key={point.periodStart} href={`/?period=${point.periodStart}`}>
            <g className="chart-bar">
              <title>{tooltip}</title>

              {isSelected && (
                <rect
                  x={x - 7}
                  y={PAD.top}
                  width={barW + 14}
                  height={plotH}
                  fill="var(--surface-sunk)"
                  rx="8"
                />
              )}

              {showCapital && point.nonConsumption > 0 && (
                <rect
                  x={x}
                  y={y(point.living + point.nonConsumption)}
                  width={barW}
                  height={Math.max(0, capitalH)}
                  fill="var(--iris)"
                  opacity={isSelected ? 0.65 : 0.4}
                  rx="4"
                />
              )}

              <rect
                x={x}
                y={y(point.living)}
                width={barW}
                height={Math.max(0, livingH)}
                fill="var(--bloom)"
                opacity={isSelected ? 1 : 0.8}
                rx="4"
              />

              <text
                className="chart-axis"
                x={x + barW / 2}
                y={H - 9}
                textAnchor="middle"
                fontWeight={isSelected ? 600 : 400}
                fill={isSelected ? 'var(--ink)' : undefined}
              >
                {monthTick(point.periodStart)}
              </text>
            </g>
          </Link>
        )
      })}

      <line className="chart-rule" x1={PAD.left} x2={W - PAD.right} y1={y(average)} y2={y(average)} />
      <text className="chart-rule-label" x={W - PAD.right + 8} y={y(average) + 4} textAnchor="start">
        {moneyWhole(average)}
      </text>
      <text className="chart-rule-label" x={W - PAD.right + 8} y={y(average) - 8} textAnchor="start">
        usual
      </text>
    </svg>
  )
}

function niceCeiling(value: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(value))
  return Math.ceil(value / (magnitude / 2)) * (magnitude / 2)
}

function compact(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}k`
  return String(Math.round(value))
}
