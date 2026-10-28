-- Phase 5a: delivery of the result notices to Pathway (webhook) and the retry of a failed evaluation.
--  * notify_next_at: when a pending notice may be tried (again); evaluating_until: lease while a re-evaluation runs.
--  * witcher_settings: small key/value table for per-project values that are NOT secrets (the address of the `deliver`
--    function, filled in per project with SQL, never in this file). No browser access.
--  * witcher_kick_delivery(): called every minute; when a notice is waiting it asks the `deliver` function (pg_net) to send it.
--  * witcher_sweep(): also marks a completed interview whose evaluation step died before it could set the notice.
--  Additive: no data changes.

alter table public.interviews add column if not exists notify_next_at timestamptz;
alter table public.interviews add column if not exists evaluating_until timestamptz;

create table if not exists public.witcher_settings (
  key text primary key check (char_length(key) between 1 and 80),
  value text not null check (char_length(value) <= 500)
);
alter table public.witcher_settings enable row level security;
revoke all on public.witcher_settings from public, anon, authenticated;
grant all on public.witcher_settings to service_role;
comment on table public.witcher_settings is 'Per-project values that are not secrets (e.g. delivery_url). No browser access.';

create extension if not exists pg_net with schema extensions;

create or replace function public.witcher_kick_delivery()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
begin
  select value into v_url from public.witcher_settings where key = 'delivery_url';
  if v_url is null or v_url = '' then return; end if;
  if not exists (
    select 1 from public.interviews
     where source = 'pathway' and notify_state = 'pending' and (notify_next_at is null or notify_next_at <= now())
  ) then return; end if;
  perform net.http_post(url := v_url, headers := '{"Content-Type": "application/json"}'::jsonb, body := '{}'::jsonb);
end
$$;

revoke all on function public.witcher_kick_delivery() from public, anon, authenticated;
grant execute on function public.witcher_kick_delivery() to service_role;

select cron.schedule('witcher-deliver', '* * * * *', $$select public.witcher_kick_delivery()$$);

create or replace function public.witcher_sweep(p_abandon_after_seconds int default 90)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  abandoned int := 0;
  expired int := 0;
  rescued int := 0;
begin
  for r in
    select id from public.interviews
     where status = 'in_progress' and last_seen_at < now() - make_interval(secs => p_abandon_after_seconds)
  loop
    if public.witcher_abandon(r.id) then abandoned := abandoned + 1; end if;
  end loop;

  update public.interviews
     set status = 'expired', notify_event = 'expired', notify_state = 'pending', session_hash = null, session_expires_at = null
   where status in ('created', 'invited') and expires_at < now();
  get diagnostics expired = row_count;

  -- The evaluation runs after the candidate's last answer. If that step never finished (the function was stopped), the
  -- notice is still sent after a few minutes; the evaluation then shows as missing and the client can ask to redo it.
  update public.interviews
     set notify_event = 'completed', notify_state = 'pending'
   where status = 'completed' and notify_event is null and completed_at < now() - interval '5 minutes';
  get diagnostics rescued = row_count;

  return jsonb_build_object('abandoned', abandoned, 'expired', expired, 'rescued', rescued);
end
$$;
