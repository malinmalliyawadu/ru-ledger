// Server-only. Imported exclusively from server components and server actions;
// nothing here may be pulled into a client bundle.
import { db } from './db.ts'
import type { ExclusionReason } from './rules-file.ts'
import { NZ_TIMEZONE, nzToday } from './time.ts'

const num = (value: unknown): number => Number(value ?? 0)

export type Settings = {
  statementStartDay: number
  largePurchaseThreshold: number
  timezone: string
}

export async function getSettings(): Promise<Settings> {
  const [row] = await db<
    { statement_start_day: number; large_purchase_threshold: string; timezone: string }[]
  >`select statement_start_day, large_purchase_threshold, timezone from settings limit 1`

  return {
    statementStartDay: row?.statement_start_day ?? 16,
    largePurchaseThreshold: num(row?.large_purchase_threshold ?? 500),
    timezone: row?.timezone ?? NZ_TIMEZONE,
  }
}

export type Period = {
  start: string
  end: string
  /** The period containing today. Exists whether or not anything has happened in it yet. */
  isCurrent: boolean
  isComplete: boolean
  /** Days into the period, 1-based. Equals totalDays once the period has closed. */
  elapsedDays: number
  totalDays: number
  hasData: boolean
}

/**
 * Every period, newest first, including the one we are living in.
 *
 * The current period is included even when it holds nothing yet. Deriving the
 * list purely from transactions means that on the 16th — the first day of a new
 * statement period — the newest period on offer is the one that just closed,
 * and the dashboard quietly answers a question about last month.
 */
export async function getPeriods(): Promise<Period[]> {
  const rows = await db<
    {
      period_start: Date
      period_end: Date
      is_current: boolean
      elapsed_days: number
      total_days: number
      has_data: boolean
    }[]
  >`
    with settings_row as (select statement_start_day from settings limit 1),
    current_period as (
      select statement_period_start(current_date, statement_start_day) as period_start
      from settings_row
    ),
    all_periods as (
      select distinct period_start from transactions
      union
      select period_start from current_period
    )
    select
      p.period_start,
      statement_period_end(p.period_start)                            as period_end,
      (p.period_start = (select period_start from current_period))    as is_current,
      (current_date - p.period_start + 1)                             as elapsed_days,
      (statement_period_end(p.period_start) - p.period_start + 1)     as total_days,
      exists (select 1 from transactions t where t.period_start = p.period_start) as has_data
    from all_periods p
    order by p.period_start desc
  `

  return rows.map((row) => {
    const totalDays = Number(row.total_days)
    return {
      start: row.period_start.toISOString().slice(0, 10),
      end: row.period_end.toISOString().slice(0, 10),
      isCurrent: row.is_current,
      isComplete: !row.is_current && Number(row.elapsed_days) > totalDays,
      elapsedDays: Math.min(Math.max(Number(row.elapsed_days), 0), totalDays),
      totalDays,
      hasData: row.has_data,
    }
  })
}

/**
 * What spending looked like by this same day of the period, averaged over the
 * periods before it.
 *
 * Comparing a part-finished period against whole-period averages is the trap
 * this whole app exists to avoid: on day three it would report spending down
 * 90% and mean nothing. Pro-rating the average linearly is no better, because
 * rent, rates and subscriptions cluster rather than spreading evenly. The only
 * honest comparison is like-for-like against the same point in prior periods.
 */
export async function getPaceComparison(
  periodStart: string,
  elapsedDays: number,
): Promise<{ average: number; periods: number }> {
  const [row] = await db<{ average: string; periods: number }[]>`
    with prior as (
      select distinct period_start from transactions
      where period_start < ${periodStart}
      order by period_start desc
      limit 12
    ),
    by_day as (
      select p.period_start,
             coalesce(sum(-t.amount) filter (where t.counts_as_spend), 0) as spend
      from prior p
      left join transactions t
        on t.period_start = p.period_start
       and t.date <= p.period_start + ${Math.max(elapsedDays - 1, 0)}::integer
      group by p.period_start
    )
    select coalesce(avg(spend), 0) as average, count(*)::int as periods from by_day
  `

  return { average: num(row?.average), periods: Number(row?.periods ?? 0) }
}

// ---------------------------------------------------------------------------
// Where the money went
// ---------------------------------------------------------------------------

export type BreakdownBand = {
  key: 'passthrough' | 'card_payment' | 'internal_transfer' | 'unidentified' | 'non_consumption' | 'living'
  label: string
  because: string
  amount: number
}

export type Breakdown = {
  bands: BreakdownBand[]
  totalOut: number
  living: number
  income: number
  passthroughRetained: number
  unclassified: number
}

/**
 * Decomposes everything that left the accounts in a month. The bands are a true
 * partition — they sum to totalOut exactly — so the headline spending figure is
 * always visibly the remainder of a subtraction rather than a number that
 * arrived from somewhere unexplained.
 */
export async function getBreakdown(periodStart: string): Promise<Breakdown> {
  const [row] = await db<Record<string, string>[]>`
    select
      coalesce(sum(-amount) filter (where exclusion_reason = 'passthrough'        and amount < 0), 0) as passthrough,
      coalesce(sum(-amount) filter (where exclusion_reason = 'card_payment'       and amount < 0), 0) as card_payment,
      coalesce(sum(-amount) filter (where exclusion_reason = 'internal_transfer'  and amount < 0), 0) as internal_transfer,
      coalesce(sum(-amount) filter (where exclusion_reason = 'unidentified'       and amount < 0), 0) as unidentified,
      coalesce(sum(-amount) filter (where exclusion_reason is null
                                     and category_kind = 'expense'
                                     and not is_consumption), 0)                                     as non_consumption,
      coalesce(sum(-amount) filter (where counts_as_spend), 0)                                       as living,
      coalesce(sum(amount)  filter (where counts_as_income), 0)                                      as income,
      coalesce(sum(amount)  filter (where exclusion_reason = 'passthrough'), 0)                      as passthrough_retained,
      coalesce(sum(-amount) filter (where classified_by = 'unmatched' and amount < 0), 0)            as unclassified
    from transactions where period_start = ${periodStart}
  `

  // The wording is the feature. Each band says what it is and, underneath, why
  // it is not spending — because "your $6,200 of outgoings was really $4,400 of
  // spending" is only believable if every dollar of the difference is named.
  const bands: BreakdownBand[] = [
    {
      key: 'passthrough',
      label: 'Passed straight through',
      because: 'Money that arrived and left again without ever being yours to spend.',
      amount: num(row?.passthrough),
    },
    {
      key: 'card_payment',
      label: 'Paying off your card',
      because: 'Settling the card, not spending on it. The purchases it covers are counted below.',
      amount: num(row?.card_payment),
    },
    {
      key: 'internal_transfer',
      label: 'Moved between your accounts',
      because: 'It changed accounts. It did not leave.',
      amount: num(row?.internal_transfer),
    },
    {
      key: 'unidentified',
      label: "Couldn't tell",
      because: 'Your bank sent no description worth reading, so this is set aside rather than guessed at.',
      amount: num(row?.unidentified),
    },
    {
      key: 'non_consumption',
      label: 'Put away',
      because: 'Savings and investing. It really left your account, but you still have it.',
      amount: num(row?.non_consumption),
    },
    {
      key: 'living',
      label: 'Actually spent',
      because: 'Everything you genuinely paid for.',
      amount: num(row?.living),
    },
  ]

  return {
    bands,
    totalOut: bands.reduce((sum, band) => sum + band.amount, 0),
    living: num(row?.living),
    income: num(row?.income),
    passthroughRetained: num(row?.passthrough_retained),
    unclassified: num(row?.unclassified),
  }
}

// ---------------------------------------------------------------------------
// Safe to spend
// ---------------------------------------------------------------------------

export type UpcomingBill = {
  merchant: string
  category: string | null
  amount: number
  dueOn: string
  daysAway: number
}

export type Outlook = {
  /** Money that has actually landed this month. */
  moneyIn: number
  /**
   * What the month is expected to bring in by the time it closes. Equal to
   * moneyIn once the month has finished, or once this month has already beaten
   * the recent average.
   */
  expectedIn: number
  /** True when expectedIn is a forecast rather than money already received. */
  incomeIsEstimated: boolean
  spent: number
  saved: number
  /** Recurring charges that are due before the month ends and have not landed yet. */
  bills: UpcomingBill[]
  billsTotal: number
  /**
   * What is genuinely free to spend for the rest of the month, after the bills
   * that are already committed to. The number this app exists to answer.
   */
  safeToSpend: number
  daysLeft: number
  perDay: number
}

/**
 * The forward-looking view of a month, which is the difference between tracking
 * a salary and tracking a contract.
 *
 * A contractor asks "what did I spend?" after the fact. Someone on a salary
 * knows almost exactly what is coming in and what is already claimed by rent,
 * power and subscriptions, so the useful question is the opposite one: of the
 * money left, how much is actually mine to spend before the next pay?
 *
 * Three things are subtracted from the month's income, and each is subtracted
 * for a different reason:
 *
 *   spent        already gone
 *   saved        gone on purpose, and not coming back this month
 *   bills        not gone yet, but not really available either
 *
 * The last is the one a bare balance gets wrong. Rent on the 28th is not
 * spending money on the 27th, however much the account says it is.
 */
export async function getOutlook(
  periodStart: string,
  periodEnd: string,
  isCurrent: boolean,
): Promise<Outlook> {
  const [totals, recurring] = await Promise.all([
    db<{ money_in: string; spent: string; saved: string }[]>`
      select
        coalesce(sum(amount)  filter (where counts_as_income), 0) as money_in,
        coalesce(sum(-amount) filter (where counts_as_spend), 0)  as spent,
        coalesce(sum(-amount) filter (where exclusion_reason is null
                                       and category_kind = 'expense'
                                       and not is_consumption), 0) as saved
      from transactions where period_start = ${periodStart}
    `,
    isCurrent ? getRecurring() : Promise.resolve([]),
  ])

  const moneyIn = num(totals[0]?.money_in)
  const spent = num(totals[0]?.spent)
  const saved = num(totals[0]?.saved)

  // Pay is fortnightly for most salaried people, so for the first half of the
  // month "money in" is genuinely half of what the month will bring. Using it
  // raw would report a shortfall every fortnight and then quietly recover,
  // which is the same mistake as pro-rating a budget in a straight line.
  const [average] = isCurrent
    ? await db<{ average: string }[]>`
        with monthly as (
          select period_start, sum(amount) filter (where counts_as_income) as income
          from transactions
          where period_start < ${periodStart}
          group by period_start
          order by period_start desc
          limit 3
        )
        select coalesce(avg(income), 0) as average from monthly
      `
    : [undefined]

  const expectedIn = isCurrent ? Math.max(moneyIn, num(average?.average)) : moneyIn
  const incomeIsEstimated = expectedIn > moneyIn + 0.005

  // Today here, not today in UTC. Every comparison below is against it: a bill
  // due this morning is either still to come or already paid depending on which
  // day this is, and on the last day of the month a UTC "today" leaves the
  // month with a day still to run that has in fact already gone.
  const todayIso = nzToday()

  // A series is "due" at its last charge plus its own interval. One that has
  // already been charged this month lands past the end of it and drops out,
  // which is what makes this a list of what is still coming rather than a list
  // of everything that recurs.
  const bills: UpcomingBill[] = isCurrent
    ? recurring
        .filter((row) => row.isConsumption && !row.possiblyCancelled)
        .map((row) => {
          const due = new Date(`${row.lastCharged}T00:00:00Z`)
          due.setUTCDate(due.getUTCDate() + row.cadenceDays)
          const dueOn = due.toISOString().slice(0, 10)
          return {
            merchant: row.merchant,
            category: row.category,
            amount: row.averageAmount,
            dueOn,
            daysAway: Math.round(
              (due.getTime() - new Date(`${todayIso}T00:00:00Z`).getTime()) / 86_400_000,
            ),
          }
        })
        .filter((bill) => bill.dueOn >= todayIso && bill.dueOn <= periodEnd)
        .sort((a, b) => a.dueOn.localeCompare(b.dueOn))
    : []

  const billsTotal = bills.reduce((sum, bill) => sum + bill.amount, 0)

  const daysLeft = isCurrent
    ? Math.max(
        0,
        Math.round(
          (new Date(`${periodEnd}T00:00:00Z`).getTime() -
            new Date(`${todayIso}T00:00:00Z`).getTime()) /
            86_400_000,
        ) + 1,
      )
    : 0

  const safeToSpend = expectedIn - spent - saved - billsTotal

  return {
    moneyIn,
    expectedIn,
    incomeIsEstimated,
    spent,
    saved,
    bills,
    billsTotal,
    safeToSpend,
    daysLeft,
    perDay: daysLeft > 0 ? safeToSpend / daysLeft : 0,
  }
}

// ---------------------------------------------------------------------------
// Trend
// ---------------------------------------------------------------------------

export type TrendPoint = {
  periodStart: string
  periodEnd: string
  living: number
  nonConsumption: number
  income: number
}

export async function getTrend(limit = 13): Promise<TrendPoint[]> {
  const rows = await db<
    { period_start: Date; period_end: Date; living: string; non_consumption: string; income: string }[]
  >`
    select period_start, period_end,
      coalesce(sum(-amount) filter (where counts_as_spend), 0) as living,
      coalesce(sum(-amount) filter (where exclusion_reason is null
                                     and category_kind = 'expense'
                                     and not is_consumption), 0) as non_consumption,
      coalesce(sum(amount)  filter (where counts_as_income), 0) as income
    from transactions
    group by period_start, period_end
    order by period_start desc
    limit ${limit}
  `

  return rows
    .map((row) => ({
      periodStart: row.period_start.toISOString().slice(0, 10),
      periodEnd: row.period_end.toISOString().slice(0, 10),
      living: num(row.living),
      nonConsumption: num(row.non_consumption),
      income: num(row.income),
    }))
    .reverse()
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export type CategoryTotal = {
  categoryId: string | null
  category: string
  kind: 'expense' | 'income'
  isConsumption: boolean
  amount: number
  count: number
  averagePerPeriod: number
}

export async function getCategoryTotals(periodStart: string | null): Promise<CategoryTotal[]> {
  const rows = await db<
    {
      category_id: string | null
      category: string | null
      category_kind: 'expense' | 'income' | null
      is_consumption: boolean
      amount: string
      count: string
      average_per_period: string
    }[]
  >`
    with periods as (
      select count(distinct period_start)::numeric as n from transactions
    ),
    totals as (
      select category_id, category, category_kind, is_consumption,
             sum(-amount) as amount, count(*) as count
      from transactions
      where exclusion_reason is null and category_kind = 'expense'
        ${periodStart ? db`and period_start = ${periodStart}` : db``}
      group by 1, 2, 3, 4
    ),
    lifetime as (
      select category_id, sum(-amount) / nullif((select n from periods), 0) as average_per_period
      from transactions
      where exclusion_reason is null and category_kind = 'expense'
      group by 1
    )
    select t.*, coalesce(l.average_per_period, 0) as average_per_period
    from totals t left join lifetime l on l.category_id = t.category_id
    order by t.amount desc
  `

  return rows.map((row) => ({
    categoryId: row.category_id,
    category: row.category ?? 'Uncategorised',
    kind: row.category_kind ?? 'expense',
    isConsumption: row.is_consumption,
    amount: num(row.amount),
    count: Number(row.count),
    averagePerPeriod: num(row.average_per_period),
  }))
}

export async function getCategories(): Promise<
  { id: string; name: string; kind: 'expense' | 'income'; isConsumption: boolean }[]
> {
  const rows = await db<
    { id: string; name: string; kind: 'expense' | 'income'; is_consumption: boolean }[]
  >`select id, name, kind, is_consumption from categories order by kind, sort_order`

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    isConsumption: row.is_consumption,
  }))
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/**
 * How many prior periods the suggested amount averages over.
 *
 * Lifetime, as the categories page uses, is the right window for "is this
 * normal for me". It is the wrong one for "what should I aim for next month",
 * where a figure from two years ago is noise. Six periods is half a year: long
 * enough to absorb a quarterly bill, short enough to reflect what life costs
 * now.
 */
const AVERAGE_PERIODS = 6

export type BudgetLine = {
  categoryId: string
  category: string
  isConsumption: boolean
  /** null means not budgeted: either never set, or explicitly switched off. */
  budget: number | null
  spent: number
  count: number
  /** Average spend per period over the periods before this one. The suggestion. */
  averagePerPeriod: number
  /**
   * What the budget would allow by this point in the period, shaped by how this
   * category has actually landed in past periods rather than pro-rated by day.
   * Equals the budget once the period has run its course.
   */
  expectedByNow: number
}

export type Budget = {
  /** Every expense category, budgeted or not, in the order the editor lists them. */
  lines: BudgetLine[]
  budgeted: BudgetLine[]
  /** Spent against, but never budgeted for. The gap between a budget and a plan. */
  unbudgeted: BudgetLine[]
  total: number
  spent: number
  unbudgetedSpent: number
  expectedByNow: number
  exists: boolean
}

/**
 * A period's budget beside what it actually cost.
 *
 * `elapsedDays` and `totalDays` come from the period itself; pass the full
 * length for a period that has closed. Expected-to-date is deliberately not a
 * straight-line pro-rate of the limit: rent lands on day one and the power bill
 * on day twenty, so a linear budget line reports every fixed cost as a blowout
 * for the first half of the period and then quietly recovers. Instead each
 * category is shaped by its own history — the share of a typical period's spend
 * that has landed by this day — and only falls back to straight-line when there
 * is no history to shape it with.
 */
export async function getBudget(
  periodStart: string,
  elapsedDays: number,
  totalDays: number,
): Promise<Budget> {
  const rows = await db<
    {
      category_id: string
      category: string
      is_consumption: boolean
      budget: string | null
      spent: string
      tx_count: string
      average_per_period: string
      shape_to_day: string
      shape_whole: string
    }[]
  >`
    with recent as (
      select distinct period_start from transactions
      where period_start < ${periodStart}
      order by period_start desc
      limit ${AVERAGE_PERIODS}
    ),
    history as (
      select
        t.category_id,
        sum(-t.amount) / nullif((select count(*) from recent), 0) as average_per_period,
        coalesce(sum(-t.amount) filter (
          where t.date <= r.period_start + ${Math.max(elapsedDays - 1, 0)}::integer), 0) as shape_to_day,
        sum(-t.amount) as shape_whole
      from recent r
      join transactions t on t.period_start = r.period_start
      where t.exclusion_reason is null and t.category_kind = 'expense'
      group by t.category_id
    ),
    actual as (
      select category_id, sum(-amount) as spent, count(*) as tx_count
      from transactions
      where period_start = ${periodStart}
        and exclusion_reason is null and category_kind = 'expense'
      group by category_id
    )
    select
      c.id                                as category_id,
      c.name                              as category,
      c.is_consumption,
      b.amount                            as budget,
      coalesce(a.spent, 0)                as spent,
      coalesce(a.tx_count, 0)             as tx_count,
      coalesce(h.average_per_period, 0)   as average_per_period,
      coalesce(h.shape_to_day, 0)         as shape_to_day,
      coalesce(h.shape_whole, 0)          as shape_whole
    from categories c
    left join budget_for_period(${periodStart}) b on b.category_id = c.id
    left join actual  a on a.category_id = c.id
    left join history h on h.category_id = c.id
    where c.kind = 'expense'
    order by c.sort_order, c.name
  `

  const straightLine = totalDays > 0 ? Math.min(elapsedDays / totalDays, 1) : 1

  const lines: BudgetLine[] = rows.map((row) => {
    const budget = row.budget === null ? null : num(row.budget)
    const whole = num(row.shape_whole)
    // Refunds can push a part-period total above the whole or below zero, so
    // the share is clamped rather than trusted.
    const share = whole > 0 ? Math.min(Math.max(num(row.shape_to_day) / whole, 0), 1) : straightLine

    return {
      categoryId: row.category_id,
      category: row.category,
      isConsumption: row.is_consumption,
      budget,
      spent: num(row.spent),
      count: Number(row.tx_count),
      averagePerPeriod: num(row.average_per_period),
      expectedByNow: budget === null ? 0 : budget * share,
    }
  })

  const budgeted = lines.filter((line) => line.budget !== null)
  const unbudgeted = lines.filter((line) => line.budget === null && line.spent > 0)

  return {
    lines,
    budgeted,
    unbudgeted,
    total: budgeted.reduce((sum, line) => sum + (line.budget ?? 0), 0),
    spent: budgeted.reduce((sum, line) => sum + line.spent, 0),
    unbudgetedSpent: unbudgeted.reduce((sum, line) => sum + line.spent, 0),
    expectedByNow: budgeted.reduce((sum, line) => sum + line.expectedByNow, 0),
    exists: budgeted.length > 0,
  }
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export type TransactionRow = {
  id: string
  date: string
  description: string
  merchant: string | null
  amount: number
  account: string
  category: string | null
  categoryId: string | null
  exclusionReason: ExclusionReason | null
  classifiedBy: 'rule' | 'override' | 'unmatched'
  isRecurring: boolean
  countsAsSpend: boolean
}

export type TransactionFilters = {
  periodStart?: string | null
  categoryId?: string | null
  search?: string | null
  minAmount?: number | null
  onlyUnmatched?: boolean
  limit?: number
}

export async function getTransactions(filters: TransactionFilters = {}): Promise<TransactionRow[]> {
  const { periodStart, categoryId, search, minAmount, onlyUnmatched, limit = 300 } = filters

  const rows = await db<
    {
      id: string
      date: Date
      description: string
      merchant_display_name: string | null
      amount: string
      account_name: string
      category: string | null
      category_id: string | null
      exclusion_reason: ExclusionReason | null
      classified_by: 'rule' | 'override' | 'unmatched'
      is_recurring: boolean
      counts_as_spend: boolean
    }[]
  >`
    select id, date, description, merchant_display_name, amount, account_name,
           category, category_id, exclusion_reason, classified_by, is_recurring, counts_as_spend
    from transactions
    where true
      ${periodStart ? db`and period_start = ${periodStart}` : db``}
      ${categoryId ? db`and category_id = ${categoryId}` : db``}
      ${search ? db`and (description ilike ${'%' + search + '%'} or merchant_display_name ilike ${'%' + search + '%'})` : db``}
      ${minAmount ? db`and abs(amount) >= ${minAmount}` : db``}
      ${onlyUnmatched ? db`and classified_by = 'unmatched'` : db``}
    order by date desc, id
    limit ${limit}
  `

  return rows.map((row) => ({
    id: row.id,
    date: row.date.toISOString().slice(0, 10),
    description: row.description,
    merchant: row.merchant_display_name,
    amount: num(row.amount),
    account: row.account_name,
    category: row.category,
    categoryId: row.category_id,
    exclusionReason: row.exclusion_reason,
    classifiedBy: row.classified_by,
    isRecurring: row.is_recurring,
    countsAsSpend: row.counts_as_spend,
  }))
}

// ---------------------------------------------------------------------------
// Recurring
// ---------------------------------------------------------------------------

export type RecurringRow = {
  merchant: string
  category: string | null
  isConsumption: boolean
  cadenceDays: number
  chargeCount: number
  averageAmount: number
  lastCharged: string
  daysSinceLast: number
  possiblyCancelled: boolean
  isPayg: boolean
  monthlyEquivalent: number
}

export async function getRecurring(): Promise<RecurringRow[]> {
  const rows = await db<
    {
      merchant: string
      category: string | null
      is_consumption: boolean
      cadence_days: number
      charge_count: string
      average_amount: string
      last_charged: Date
      days_since_last: string
      is_payg: boolean
    }[]
  >`
    select
      merchant_display_name as merchant,
      max(category)         as category,
      bool_and(is_consumption) as is_consumption,
      max(recurrence_days)  as cadence_days,
      count(*)              as charge_count,
      avg(-amount)          as average_amount,
      max(date)             as last_charged,
      (current_date - max(date)) as days_since_last,
      bool_or(is_payg)      as is_payg
    from transactions
    where is_recurring
    group by merchant_display_name
    order by avg(-amount) * (30.0 / nullif(max(recurrence_days), 0)) desc
  `

  return rows.map((row) => {
    const cadenceDays = Number(row.cadence_days) || 30
    const daysSinceLast = Number(row.days_since_last)
    const averageAmount = num(row.average_amount)

    return {
      merchant: row.merchant,
      category: row.category,
      isConsumption: row.is_consumption,
      cadenceDays,
      chargeCount: Number(row.charge_count),
      averageAmount,
      lastCharged: row.last_charged.toISOString().slice(0, 10),
      daysSinceLast,
      // Overdue by more than twice its own rhythm. PAYG merchants are exempt:
      // they charge on a cycle-ish rhythm but stopping is not a cancellation.
      possiblyCancelled: !row.is_payg && daysSinceLast > cadenceDays * 2,
      isPayg: row.is_payg,
      monthlyEquivalent: (averageAmount * 30) / cadenceDays,
    }
  })
}

// ---------------------------------------------------------------------------
// Large purchases
// ---------------------------------------------------------------------------

export type LargePurchaseSummary = {
  rows: TransactionRow[]
  total: number
  shareOfLiving: number
}

export async function getLargePurchases(
  threshold: number,
  periodStart: string | null,
): Promise<LargePurchaseSummary> {
  const rows = await getTransactions({ periodStart, minAmount: threshold, limit: 500 })
  const purchases = rows.filter((row) => row.countsAsSpend && row.amount < 0)
  const total = purchases.reduce((sum, row) => sum + Math.abs(row.amount), 0)

  const [totals] = await db<{ living: string }[]>`
    select coalesce(sum(-amount) filter (where counts_as_spend), 0) as living
    from transactions
    where true ${periodStart ? db`and period_start = ${periodStart}` : db``}
  `

  const living = num(totals?.living)

  return { rows: purchases, total, shareOfLiving: living > 0 ? total / living : 0 }
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export type StaleAccount = {
  name: string
  source: 'akahu' | 'csv'
  daysSinceTransaction: number | null
  daysSinceSync: number | null
}

export type AccountRow = {
  id: string
  name: string
  institution: string | null
  source: 'akahu' | 'csv'
  balance: number | null
  oldestTransaction: string | null
  latestTransaction: string | null
  daysSinceTransaction: number | null
  daysSinceSync: number | null
  transactionCount: number
  staleAfterDays: number
  isStale: boolean
}

export async function getAccounts(): Promise<AccountRow[]> {
  const rows = await db<
    {
      id: string
      name: string
      institution: string | null
      source: 'akahu' | 'csv'
      current_balance: string | null
      oldest_transaction_date: Date | null
      latest_transaction: Date | null
      days_since_transaction: number | null
      days_since_sync: number | null
      transaction_count: string
      stale_after_days: number
      is_stale: boolean
    }[]
  >`select * from account_health order by source, institution nulls last, name`

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    institution: row.institution,
    source: row.source,
    balance: row.current_balance === null ? null : num(row.current_balance),
    oldestTransaction: row.oldest_transaction_date?.toISOString().slice(0, 10) ?? null,
    latestTransaction: row.latest_transaction?.toISOString().slice(0, 10) ?? null,
    daysSinceTransaction: row.days_since_transaction,
    daysSinceSync: row.days_since_sync,
    transactionCount: Number(row.transaction_count),
    staleAfterDays: row.stale_after_days,
    isStale: row.is_stale,
  }))
}

export type SyncRun = {
  trigger: string
  status: string
  startedAt: string
  transactionsNew: number
  uncategorised: number | null
  error: string | null
}

export async function getRecentSyncs(limit = 5): Promise<SyncRun[]> {
  const rows = await db<
    {
      trigger: string
      status: string
      started_at: Date
      transactions_new: number
      uncategorised_count: number | null
      error: string | null
    }[]
  >`
    select trigger, status, started_at, transactions_new, uncategorised_count, error
    from sync_runs order by started_at desc limit ${limit}
  `

  return rows.map((row) => ({
    trigger: row.trigger,
    status: row.status,
    startedAt: row.started_at.toISOString(),
    transactionsNew: row.transactions_new,
    uncategorised: row.uncategorised_count,
    error: row.error,
  }))
}

export type Health = {
  transactions: number
  unmatched: number
  coverage: number
  drift: number
  lastSynced: string | null
  stale: StaleAccount[]
  accounts: { name: string; institution: string | null; balance: number; oldest: string | null }[]
}

export async function getHealth(): Promise<Health> {
  const [recon] = await db<Record<string, string>[]>`
    select raw_count, unmatched_count,
           net_cash - (income_signed + spend_signed + non_consumption_signed
                       + excluded_signed + unclassified_signed) as drift
    from reconciliation
  `

  const accounts = await db<
    { name: string; institution: string | null; current_balance: string; oldest_transaction_date: Date | null; last_synced_at: Date | null }[]
  >`select name, institution, current_balance, oldest_transaction_date, last_synced_at from accounts order by name`

  const staleRows = await db<
    {
      name: string
      source: 'akahu' | 'csv'
      days_since_transaction: number | null
      days_since_sync: number | null
    }[]
  >`
    select name, source, days_since_transaction, days_since_sync
    from account_health where is_stale order by source, name
  `

  const total = Number(recon?.raw_count ?? 0)
  const unmatched = Number(recon?.unmatched_count ?? 0)
  const lastSynced = accounts
    .map((a) => a.last_synced_at)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0]

  return {
    transactions: total,
    unmatched,
    coverage: total === 0 ? 1 : 1 - unmatched / total,
    drift: num(recon?.drift),
    lastSynced: lastSynced?.toISOString() ?? null,
    stale: staleRows.map((row) => ({
      name: row.name,
      source: row.source,
      daysSinceTransaction: row.days_since_transaction,
      daysSinceSync: row.days_since_sync,
    })),
    accounts: accounts.map((a) => ({
      name: a.name,
      institution: a.institution,
      balance: num(a.current_balance),
      oldest: a.oldest_transaction_date?.toISOString().slice(0, 10) ?? null,
    })),
  }
}
