-- Not every account can be connected.
--
-- Akahu has no integration for the Latitude/Gem Flight Centre Mastercard, so
-- that account arrives as a manually imported CSV. The schema assumed an Akahu
-- id on every account and every transaction, which is no longer true, and a
-- synthetic 'akahu_id' on a row that never came from Akahu would be a lie in
-- the column name.
--
-- So: akahu_id becomes external_id, and a source column says where the row came
-- from. The natural key is now (source, external_id), which stays unique across
-- sources and keeps every upsert idempotent.
--
-- This matters more than naming. The Kiwibank side of a Gem card payment is
-- excluded as a card_payment because the purchases it settles are counted
-- elsewhere. If the CSV is never imported, those purchases do not exist, the
-- payment is still excluded, and spending is silently understated by the whole
-- card balance. Manual sources therefore have to be visibly, loudly stale
-- rather than quietly absent.

-- ---------------------------------------------------------------------------
-- accounts
-- ---------------------------------------------------------------------------

alter table accounts rename column akahu_id to external_id;
alter table accounts drop constraint accounts_akahu_id_key;

alter table accounts add column source text not null default 'akahu';
alter table accounts add constraint accounts_source_check check (source in ('akahu', 'csv'));
alter table accounts add constraint accounts_source_external_id_key unique (source, external_id);

-- How long this account may go without new data before it is considered stale.
-- Akahu accounts sync daily; a CSV I have to remember to export gets a month.
alter table accounts add column stale_after_days integer not null default 3;
alter table accounts add constraint accounts_stale_after_days_check check (stale_after_days > 0);

comment on column accounts.source is
  'akahu = synced automatically. csv = imported by hand, and therefore able to fall behind without anything failing.';

-- ---------------------------------------------------------------------------
-- transactions_raw
-- ---------------------------------------------------------------------------

alter table transactions_raw rename column akahu_id to external_id;
alter table transactions_raw drop constraint transactions_raw_akahu_id_key;

alter table transactions_raw add column source text not null default 'akahu';
alter table transactions_raw add constraint transactions_raw_source_check check (source in ('akahu', 'csv'));
alter table transactions_raw add constraint transactions_raw_source_external_id_key unique (source, external_id);

comment on column transactions_raw.external_id is
  'Akahu''s stable _id for synced rows. For CSV rows, a content hash of the account, date, amount, description and duplicate index, so re-importing the same export is a no-op.';

-- The immutability guard names the column, so it has to be rebuilt.
create or replace function transactions_raw_immutable_guard()
returns trigger
language plpgsql
as $$
begin
  if new.id <> old.id or new.external_id <> old.external_id or new.account_id <> old.account_id then
    raise exception 'transactions_raw identity is immutable (external_id=%)', old.external_id;
  end if;

  if new.raw is distinct from old.raw and new.revised_at is not distinct from old.revised_at then
    raise exception 'raw payload changed for external_id=% without stamping revised_at', old.external_id;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- views
-- ---------------------------------------------------------------------------

drop view reconciliation;
drop view transactions;

create view transactions with (security_invoker = on) as
select
  r.id,
  r.external_id,
  r.source,
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

-- ---------------------------------------------------------------------------
-- account_health: is any source quietly behind?
-- ---------------------------------------------------------------------------

create view account_health with (security_invoker = on) as
select
  a.id,
  a.name,
  a.institution,
  a.source,
  a.current_balance,
  a.oldest_transaction_date,
  a.stale_after_days,
  max(r.date)                                as latest_transaction,
  (current_date - max(r.date))               as days_behind,
  count(r.id)                                as transaction_count,
  ((current_date - max(r.date)) > a.stale_after_days) as is_stale
from accounts a
left join transactions_raw r on r.account_id = a.id
where a.is_active
group by a.id, a.name, a.institution, a.source, a.current_balance,
         a.oldest_transaction_date, a.stale_after_days;

comment on view account_health is
  'A manually imported account that stops being imported does not fail, it just stops appearing. This is what makes that visible.';

grant select on account_health to finance_web, finance_sync;
