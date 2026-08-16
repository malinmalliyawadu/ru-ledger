-- Budgets: an intended limit per category, versioned by the period it starts.
--
-- The obvious shape is a row per category per period. It is wrong here for the
-- same reason statement periods are a function rather than a stored column: a
-- budget is a standing intention that changes rarely, so materialising it
-- against every period means writing twenty rows a month forever, and answering
-- "what was I aiming for in March" depends on those rows having been written.
--
-- So a line records the amount and the date it takes effect, and the budget in
-- force for a period is the newest line at or before that period's start. Set
-- rent once and it applies to every period until it is set again. A past period
-- is judged against the figure that was actually in force at the time, which is
-- the only comparison worth making.
--
-- effective_from is a plain date rather than a foreign key onto some period
-- table, because periods are computed from settings.statement_start_day and
-- move when that setting changes. "Newest line at or before the period start"
-- keeps resolving sensibly after such a change; a stored period key would not.

create table budget_lines (
  id             uuid primary key default gen_random_uuid(),
  category_id    uuid not null references categories (id) on delete cascade,
  effective_from date not null,

  -- null is not "no opinion", it is the opinion: stop budgeting this category
  -- from here on. Without it, clearing a limit would have to delete the line,
  -- and the older line underneath would resurface as though nothing changed.
  amount         numeric(14, 2),

  note           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  unique (category_id, effective_from),

  constraint budget_lines_amount_non_negative check (amount is null or amount >= 0)
);

comment on table budget_lines is
  'Versioned budget. One line per category per change, not per category per period. The line in force for a period is the newest one whose effective_from is at or before the period start.';

comment on column budget_lines.amount is
  'The limit, as a positive number, against spend measured the same way the categories page measures it. null means deliberately not budgeted from this period on, which is different from never having been budgeted.';

create index budget_lines_lookup_idx on budget_lines (category_id, effective_from desc);

create trigger budget_lines_set_updated_at
  before update on budget_lines
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- budget_for_period
-- ---------------------------------------------------------------------------

-- The single implementation of "which line is in force". Every query that
-- compares a budget against actual spending goes through this, so no page can
-- resolve a version differently from another.
--
-- Tombstones are returned with a null amount rather than filtered out. A caller
-- comparing budget to spend treats null as unbudgeted either way, but the
-- editor needs to tell "switched off in March" from "never set", or saving a
-- blank field would write a redundant tombstone every time.
create or replace function budget_for_period(period_start date)
returns table (category_id uuid, amount numeric, effective_from date)
language sql
stable
as $$
  select distinct on (b.category_id) b.category_id, b.amount, b.effective_from
  from budget_lines b
  where b.effective_from <= period_start
  order by b.category_id, b.effective_from desc;
$$;

comment on function budget_for_period(date) is
  'The budget in force for the statement period starting on the given date. A row with a null amount means the category was explicitly unbudgeted from some earlier period onward.';

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------

-- A budget is a classification input a human edits from the UI, so it sits with
-- rules and overrides on the finance_web side of the line. finance_sync reads
-- it and can never write it.
grant select on budget_lines to finance_web, finance_sync;
grant insert, update, delete on budget_lines to finance_web;
