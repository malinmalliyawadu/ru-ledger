-- Settings, statement periods, and the read views the app and the
-- reconciliation test both go through.

-- ---------------------------------------------------------------------------
-- settings  (single row)
-- ---------------------------------------------------------------------------

create table settings (
  id                       boolean primary key default true,
  statement_start_day      integer not null default 16,
  large_purchase_threshold numeric(14, 2) not null default 500,
  timezone                 text not null default 'Pacific/Auckland',
  updated_at               timestamptz not null default now(),

  constraint settings_singleton check (id),
  -- 28 is the highest day that exists in every month, so no period is ever
  -- partial or skipped.
  constraint settings_start_day_range check (statement_start_day between 1 and 28)
);

insert into settings (id) values (true);

create trigger settings_set_updated_at
  before update on settings
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- statement periods
-- ---------------------------------------------------------------------------

create or replace function statement_period_start(d date, start_day integer)
returns date
language sql
immutable
as $$
  select case
    when extract(day from d)::integer >= start_day
      then date_trunc('month', d)::date + (start_day - 1)
    else (date_trunc('month', d)::date - interval '1 month')::date + (start_day - 1)
  end;
$$;

create or replace function statement_period_end(period_start date)
returns date
language sql
immutable
as $$
  select (period_start + interval '1 month' - interval '1 day')::date;
$$;

comment on function statement_period_start(date, integer) is
  'A statement period is keyed by its start date. With statement_start_day = 16, 2026-08-15 belongs to the period starting 2026-07-16 and ending 2026-08-15.';

-- ---------------------------------------------------------------------------
-- transactions  (the join everything reads)
-- ---------------------------------------------------------------------------

-- security_invoker: the view must not become a hole around the privileges on
-- the tables underneath it.
--
-- Overrides are applied HERE, at read time, and nowhere else. That is what
-- makes "an override always beats the rules and is never touched by a
-- recompute" structurally true rather than a convention: the recompute writes
-- transactions_enriched from rules alone and has no idea overrides exist, and
-- the UI writes overrides alone and never touches the derived layer. One
-- implementation of precedence, in one place.
create view transactions with (security_invoker = on) as
select
  r.id,
  r.akahu_id,
  r.account_id,
  a.name                     as account_name,
  a.institution,
  r.date,
  r.description,
  r.amount,
  statement_period_start(r.date, s.statement_start_day)                        as period_start,
  statement_period_end(statement_period_start(r.date, s.statement_start_day))  as period_end,
  eff.category_id,
  c.name                     as category,
  c.kind                     as category_kind,
  coalesce(c.is_consumption, false) as is_consumption,
  e.merchant_display_name,
  eff.exclusion_reason,
  e.is_recurring,
  e.is_payg,
  e.is_one_off,
  e.recurrence_days,
  e.rule_id,
  eff.classified_by,
  (o.transaction_id is not null) as is_overridden,
  -- The headline "what I spend" test, in one place so no page can disagree
  -- with another about it.
  (eff.exclusion_reason is null and c.kind = 'expense' and c.is_consumption) as counts_as_spend,
  (eff.exclusion_reason is null and c.kind = 'income')                       as counts_as_income
from transactions_raw r
join accounts a               on a.id = r.account_id
cross join settings s
left join transactions_enriched e on e.transaction_id = r.id
left join overrides o             on o.transaction_id = r.id
cross join lateral (
  select
    case
      when o.category_id is not null      then o.category_id
      when o.exclusion_reason is not null then null
      else e.category_id
    end as category_id,
    case
      when o.category_id is not null      then null
      when o.exclusion_reason is not null then o.exclusion_reason
      when o.force_included               then null
      else e.exclusion_reason
    end as exclusion_reason,
    case
      when o.transaction_id is not null then 'override'::classified_by
      else coalesce(e.classified_by, 'unmatched'::classified_by)
    end as classified_by
) eff
left join categories c            on c.id = eff.category_id;

-- ---------------------------------------------------------------------------
-- reconciliation
-- ---------------------------------------------------------------------------

-- Every raw transaction lands in exactly one bucket. The signed amounts of the
-- buckets must add back up to raw net cash; if they do not, something is
-- double counted or lost.
create view reconciliation with (security_invoker = on) as
select
  count(*)                                                        as raw_count,
  count(*) filter (where e.transaction_id is null)                as unenriched_count,
  count(*) filter (where e.classified_by = 'unmatched')           as unmatched_count,
  coalesce(sum(r.amount), 0)                                      as net_cash,
  coalesce(sum(r.amount) filter (where t.counts_as_income), 0)    as income_signed,
  coalesce(sum(r.amount) filter (where t.counts_as_spend), 0)     as spend_signed,
  coalesce(sum(r.amount) filter (
    where e.exclusion_reason is null
      and t.category_kind = 'expense'
      and not t.is_consumption), 0)                               as non_consumption_signed,
  coalesce(sum(r.amount) filter (where e.exclusion_reason is not null), 0) as excluded_signed,
  coalesce(sum(r.amount) filter (
    where e.transaction_id is null or e.classified_by = 'unmatched'), 0)   as unclassified_signed,
  coalesce(sum(r.amount) filter (where e.exclusion_reason = 'passthrough' and r.amount > 0), 0) as passthrough_in,
  coalesce(sum(r.amount) filter (where e.exclusion_reason = 'passthrough' and r.amount < 0), 0) as passthrough_out
from transactions_raw r
join transactions t                on t.id = r.id
left join transactions_enriched e  on e.transaction_id = r.id;

comment on view reconciliation is
  'net_cash must equal income_signed + spend_signed + non_consumption_signed + excluded_signed + unclassified_signed. All figures keep the Akahu sign convention, so spend_signed is negative.';
