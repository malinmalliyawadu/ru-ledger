-- Calendar months, not statement periods.
--
-- The version this was forked from tracks a contractor, whose money arrives
-- irregularly and whose natural unit of time was the credit card statement
-- period running the 16th to the 15th. Ru is salaried: pay lands once a month
-- and everything she is asked about ("how did August go?", "is rent paid this
-- month?") is phrased in calendar months. Grouping by anything else would mean
-- translating in her head every time she reads a figure.
--
-- No new machinery is needed for this. statement_period_start(d, 1) already
-- returns the first of the month and statement_period_end returns the last, so
-- a calendar month is just the existing period function with start_day = 1.
-- The setting is left in place rather than removed: if she is ever paid on, say,
-- the 20th and wants the month to run payday to payday, that is one dropdown
-- and every figure in the app regroups, because nothing stores a period.

alter table settings alter column statement_start_day set default 1;

update settings set statement_start_day = 1 where statement_start_day = 16;

comment on column settings.statement_start_day is
  'Day of the month each period opens on. 1 = calendar months, which is the default here. Capped at 28 so no month can produce a partial period.';
