-- PROD_CLEANUP_1004.sql
-- NOT EXECUTED. Nothing in this repo runs it; it is for a person to run by hand against production, after reading
-- the preview.
--
-- What it removes: two test rows from the production database:
--   partner_leads    1 row, created 1 Oct 2026 by a test submission through the partnerships form
--   analytics_events 1 row, event_name 'production_smoke_test', anonymous (user_id is null)
-- Schemas: partner_leads is migration 026_partner_leads_and_sponsored_ads.sql; analytics_events is 022_growth_monetization_analytics.sql.
-- Nothing else is touched: not users, plans, chats, or any other table. sponsored_ads.partner_id points at
-- partner_leads with ON DELETE SET NULL (it was empty on 3 Oct), so no other row is deleted or blocked.
--
-- How to run (on the server, with the database role; the connection string stays in the server's .env):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f PROD_CLEANUP_1004.sql
-- 1. Run it as it is. It prints the preview, "deletes" inside a transaction and ends in ROLLBACK, so it changes nothing.
-- 2. Read the output. The preview must show exactly the rows described above. If a real enquiry or a real event is
--    in the list, stop and narrow the WHERE clauses below.
-- 3. Only then change the last statement from ROLLBACK to COMMIT and run it again.
--
-- How the WHERE clauses stay conservative:
--   * a fixed date window, so later rows (real enquiries, real events) can never match;
--   * partner_leads: status must still be 'new' (a lead somebody has answered is never touched);
--   * analytics_events: the exact event name, and user_id is null;
--   * a guard aborts the whole transaction if more rows match than expected.

-- =====================================================================================================================
-- 1. PREVIEW (read-only, outside the transaction). SELECT count(*) first, then the rows themselves.
-- =====================================================================================================================

select 'partner_leads' as tbl,
       count(*) as total_rows,
       count(*) filter (where created_at >= timestamptz '2026-10-01 00:00:00+00'
                          and created_at <  timestamptz '2026-10-03 00:00:00+00'
                          and status = 'new') as rows_this_script_would_delete
from partner_leads;

select 'analytics_events' as tbl,
       count(*) as total_rows,
       count(*) filter (where event_name = 'production_smoke_test'
                          and user_id is null
                          and created_at < timestamptz '2026-10-04 00:00:00+00') as rows_this_script_would_delete
from analytics_events;

-- The partner_leads table is tiny, so every row is listed. The row to delete is the one made on 1 Oct 2026.
select id, created_at, status, business_name, contact_name, email, city, country, budget, left(message, 120) as message_start
from partner_leads
order by created_at;

-- Every event name with its count, so a real event is never mistaken for the test one.
select event_name, count(*) as n, count(*) filter (where user_id is null) as anonymous, min(created_at) as first_seen, max(created_at) as last_seen
from analytics_events
group by event_name
order by n desc;

-- =====================================================================================================================
-- 2. THE CLEANUP, inside a transaction that rolls back unless you change the last line.
-- =====================================================================================================================

begin;

-- What would go, decided once, so the guard and the deletes use the same set.
create temp table _cleanup_partner_leads on commit drop as
  select id from partner_leads
  where created_at >= timestamptz '2026-10-01 00:00:00+00'
    and created_at <  timestamptz '2026-10-03 00:00:00+00'
    and status = 'new';

create temp table _cleanup_analytics_events on commit drop as
  select id from analytics_events
  where event_name = 'production_smoke_test'
    and user_id is null
    and created_at < timestamptz '2026-10-04 00:00:00+00';

-- Guard: 1 row is expected in each table. Anything above these ceilings means the data is not what this script was written for.
do $$
declare
  leads  int;
  events int;
begin
  select count(*) into leads  from _cleanup_partner_leads;
  select count(*) into events from _cleanup_analytics_events;
  if leads > 2 then
    raise exception 'refusing to continue: % partner_leads rows match, expected 1 (ceiling 2)', leads;
  end if;
  if events > 5 then
    raise exception 'refusing to continue: % analytics_events rows match, expected 1 (ceiling 5)', events;
  end if;
  raise notice 'will delete % partner_leads row(s) and % analytics_events row(s)', leads, events;
end
$$;

delete from partner_leads
where id in (select id from _cleanup_partner_leads)
returning id, created_at, business_name, email;

delete from analytics_events
where id in (select id from _cleanup_analytics_events)
returning id, created_at, event_name;

-- What is left, inside the transaction.
select (select count(*) from partner_leads)    as partner_leads_after,
       (select count(*) from analytics_events) as analytics_events_after;

-- Default: undo everything. To apply, replace the next line with COMMIT; and run the file again.
rollback;
-- commit;
