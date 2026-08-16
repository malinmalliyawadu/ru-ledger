# Ru's Ledger

Personal finance tracking for a salaried New Zealander. Pulls transactions from
Akahu daily, sorts them with an editable rule set, and answers the question a
bank balance cannot: **of this month's money, how much is actually still yours
to spend?**

Next.js (App Router, TypeScript), Postgres, self-hosted. Four runtime
dependencies: `next`, `react`, `react-dom`, `postgres`.

> Forked from [finance-tracker](https://github.com/malinmalliyawadu/finance-tracker),
> which tracks a contractor. The engine, schema and reconciliation model are
> shared; the money model, the interface and the tone are not. See
> [What changed from the fork](#what-changed-from-the-fork).

> **The app has no authentication.** Anyone who can reach the URL sees every
> figure in it. Put Basic Auth on the proxy, or keep it off the public internet,
> until that is addressed.

## Safe to spend

The headline figure on the dashboard, and the reason this fork exists.

Someone on a salary knows almost exactly what is coming in, and knows that a
large slice of it is already claimed by rent, power and subscriptions that have
not been charged yet. A bank balance ignores all of that: on the 27th it says
you have $900, and on the 28th rent takes $360 of it.

```
safe to spend  =  expected income
                −  spent so far
                −  put away
                −  bills still to land this month
```

Each term is doing something a balance does not:

- **expected income** — what has landed, or the average of the last three months
  if that is higher and the month is still running. Pay is fortnightly for most
  people, so using only what has arrived reports a crisis every second week and
  then quietly recovers. Flagged in the interface whenever it is a forecast
  rather than money in the account.
- **put away** — savings and investing. It really left the account, so a figure
  that ignored it would be flattering and wrong.
- **bills still to land** — every recurring charge whose next due date falls
  before the month ends. Worked out from the gaps between past charges, not from
  a list anybody maintains.

A month that has already closed shows *left over* instead, and drops the
forecast entirely.

## What changed from the fork

| | finance-tracker | Ru's Ledger |
| --- | --- | --- |
| Income | Gross contracting pay in, tax provider out, only the net retained | Net salary, already taxed at source |
| Passthrough rules | Load-bearing — mis-handling them is a ~$132k error | Empty. PAYE, KiwiSaver and student loan never reach the bank |
| Period | Statement month, 16th to the 15th | Calendar month, the 1st to the end |
| Headline | "What I actually spend" — backward looking | "Yours to spend" — forward looking |
| Liabilities | Three mortgages, modelled as credit cards | A single credit card |
| Sources | Akahu plus a manual Gem CSV | Akahu, with CSV import kept for anything it cannot reach |

The passthrough machinery is kept rather than removed. It costs nothing while
unused, the reconciliation identity and the schema stay shared with the fork,
and the situation it models is not impossible.

**Rabobank note.** Akahu's Rabobank integration is
[limited to agribusiness accounts and does not cover online savings accounts](https://developers.akahu.nz/docs/integrations).
If the Rabobank account here is an online saver, it cannot be connected — export
a CSV and use the import on the Accounts page instead. ANZ is fully supported.

## Local setup

```bash
npm install
cp .env.example .env
docker run -d --name ru-ledger-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=ruledger -p 54323:5432 postgres:17
npm run db:reset        # apply every migration from zero
npm run seed:rules      # categories, rules and aliases from the JSON
npm run seed:demo       # thirteen months of synthetic transactions
npm run recompute       # sort them
npm run dev
```

With that `.env`:

```
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54323/ruledger
```

Demo data is trivially separable from real data:

```sql
delete from transactions_raw where external_id like 'demo_%';
```

## Scripts

| Command              | Does                                                                |
| -------------------- | ------------------------------------------------------------------- |
| `npm run db:migrate` | applies outstanding migrations                                       |
| `npm run db:reset`   | drops the schema and rebuilds from zero                              |
| `npm run seed:rules` | loads categories, rules and aliases; idempotent                      |
| `npm run seed:demo`  | thirteen months of synthetic transactions, all prefixed `demo_`      |
| `npm run backfill`   | pulls every Akahu account; `--years N`, `--dry-run`                  |
| `npm run sync`       | the daily job: fetch, sort, report; `--days N`, `--refresh`          |
| `npm run import:csv` | imports a statement CSV; `--dry-run`                                 |
| `npm run recompute`  | rebuilds `transactions_enriched` from raw + rules. Fetches nothing.  |
| `npm run typecheck`  | `tsc --noEmit`                                                       |
| `npm test`           | engine, cadence, budget and reconciliation. Needs `DATABASE_URL`.    |

`npm test` deliberately fails rather than skips when `DATABASE_URL` is unset:
the reconciliation assertions are meant to break CI, and a skipped test that
should have failed is worse than no test.

## Tuning the rules

`data/categorisation-rules.json` is the source of truth. Edit it and re-run
`npm run seed:rules`; the seed is idempotent and keyed on
`(rule_type, pattern, applies_to)`, so rule ids stay stable and existing
references survive. Patterns removed from the file are disabled rather than
deleted. Rules edited directly in the database carry `source = 'manual'` and the
seed leaves them alone.

Array order is the evaluation order and is load-bearing: pharmacy is tested
before groceries, coffee before eating out, exclusions before every category.

**Write the pattern against the truncated descriptor.** ANZ cuts the merchant
field at a fixed width, so the word a rule is reaching for is routinely missing
its last letters: the council arrives as `WELLINGTON CITY COUNCI`, the
restaurant as `AMAYJEN THE RESTAUR`, the ice cream as `DUCK ISLAND ICE CREA`.
A rule written against the real trading name looks correct and never fires.

**The rule set stays deliberately conservative about exclusions.**
Under-excluding shows up as a visible transfer sitting in the uncategorised
pile, which takes one click to fix. Over-excluding silently hides real spending,
which nothing surfaces. The one thing still left out on purpose is **transfers
between your own accounts** — banks write these with the account holder's own
name or account number, so each has to be recognised rather than guessed. There
is a worked example in `EXCLUSION_REASONS` (`^transfer from everyday`) to copy.

The rest of the pile is one-off merchants and person-to-person payments, which
are cheaper to fix with a manual override on the row than with a rule that will
never match twice. Open **Everything → Still to sort** and work down the list;
anything that appears three or more times is worth a pattern.

## Deploying

Two resources. Migrations apply themselves — the container runs
`scripts/migrate.ts` before it serves, so a deploy carrying a new migration
cannot come up against the old schema.

**1. Postgres.** Then, once, from the app container:

```bash
npm run seed:rules && npm run backfill && npm run recompute
```

**2. The app.** Dockerfile build, port 3000. Set `DATABASE_URL`,
`AKAHU_USER_TOKEN` and `AKAHU_APP_ID_TOKEN`.

Leave `PGSSLMODE` empty when Postgres shares a private network with the app. Set
`require` only when the connection leaves the host.

The **build** needs network access, because `next/font` downloads and self-hosts
the three fonts. The runtime does not.

**Scheduled task**, daily, in the app container:

```bash
node scripts/sync.ts
```

It re-fetches a 14-day overlapping window rather than resuming from the last
transaction seen: banks post transactions days late and cards revise pending
amounts, so resuming exactly where the last run stopped silently drops rows. The
upsert is keyed on `(source, external_id)`, so the overlap costs nothing. Each
run writes a `sync_runs` row, so a sync that quietly stops returning
transactions shows up as a run with `new: 0` rather than as a quiet month.

Optionally split the database credentials.
`db/migrations/0004_roles_and_grants.sql` creates `finance_web` and
`finance_sync` with different privileges. Both fall back to `DATABASE_URL`.

## Design

The palette is pōhutukawa in December — coral-crimson, jade, the pale shell sand
it grows out of, and the dusk violet behind it. Every hue has a job rather than
being decoration:

| | |
| --- | --- |
| **bloom** coral | money you spent |
| **jade** green | money that is still yours |
| **iris** violet | money you put away — gone from the account, still yours |
| **honey** amber | money already claimed: bills coming, ahead of pace |
| **berry** deep red | over. Darker and less pink than bloom on purpose, and never used without a word beside it |
| **quiet** warm grey | money that does not count at all. Drawn hatched as well as grey, so the distinction survives a screenshot or a reader who does not see these colours the way they were drawn |

Fraunces carries the personality and is spent only on headings and the one
figure that matters. Plus Jakarta Sans does the reading. DM Mono lines up
columns of currency.

On a phone the sidebar becomes five fixed tabs rather than a row that scrolls
sideways, because the last two links of a scrolling row are invisible and
nothing tells you they are there.

## Layout

```
data/categorisation-rules.json   the rule set, source of truth for the seed
db/migrations/                   schema, checked in, applied in filename order
scripts/seed-rules.ts            idempotent loader for categories/rules/aliases
scripts/seed-demo.ts             synthetic transactions for development
src/lib/categorise.ts            the engine: rules in, verdict out. Pure.
src/lib/recurring.ts             cadence detection from the gaps between charges
src/lib/queries.ts               every SQL query the pages use, incl. getOutlook
src/lib/budget.ts                budget verdicts: on track, ahead of pace, over
src/components/safe-to-spend.tsx the headline and the month track
src/app/                         the seven pages
docs/schema.md                   the schema and why it is shaped that way
```

## Secrets

`.env.example` is committed. `.env` is not, and neither is anything else
matching `.env.*`. No database credential is ever exposed to the browser: the
Next.js server is the only thing that opens a socket to Postgres.
