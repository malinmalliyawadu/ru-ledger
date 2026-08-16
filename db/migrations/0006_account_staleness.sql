-- Staleness has to mean "this source is broken", not "this account is quiet".
--
-- The first version measured how long it had been since the newest transaction.
-- That flagged all three mortgages and the Zero Visa on the very first sync,
-- because a mortgage posts once a month and an unused credit card posts never.
-- A warning that fires on healthy accounts is worse than no warning: it trains
-- you to ignore the one that matters.
--
-- The two sources fail differently, so they are measured differently:
--
--   akahu  the sync either reached the account or it did not. last_synced_at
--          answers that, and it is independent of whether money moved.
--   csv    nothing automated touches it. The only evidence it is current is
--          the date of the newest transaction in the last import.

drop view account_health;

create view account_health with (security_invoker = on) as
select
  a.id,
  a.name,
  a.institution,
  a.source,
  a.current_balance,
  a.oldest_transaction_date,
  a.stale_after_days,
  a.last_synced_at,
  max(r.date)                                  as latest_transaction,
  (current_date - max(r.date))                 as days_since_transaction,
  extract(day from now() - a.last_synced_at)::integer as days_since_sync,
  count(r.id)                                  as transaction_count,
  case
    when a.source = 'csv' then
      -- No import in a month means spending is being understated: the card
      -- payment settling these purchases is excluded whether or not the
      -- purchases themselves ever arrived.
      coalesce(current_date - max(r.date), 9999) > a.stale_after_days
    else
      -- Never synced, or not synced recently enough. Says nothing about
      -- whether the account has been used.
      a.last_synced_at is null
      or now() - a.last_synced_at > make_interval(days => a.stale_after_days)
  end as is_stale
from accounts a
left join transactions_raw r on r.account_id = a.id
where a.is_active
group by a.id, a.name, a.institution, a.source, a.current_balance,
         a.oldest_transaction_date, a.stale_after_days, a.last_synced_at;

comment on view account_health is
  'is_stale means the source is not being kept current, not that the account is idle. Akahu accounts are judged on last_synced_at, CSV accounts on the newest transaction imported.';

grant select on account_health to finance_web, finance_sync;
