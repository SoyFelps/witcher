-- Retention (owner decision 2026-11-01): every interview is erased one year after it was created, whatever its state.
--  * witcher_purge_old(): deletes the interviews older than one year. The transcript (interview_messages) goes with them (on delete
--    cascade), so nothing about the interview is left: no name, e-mail, questions, evaluation or conversation. Not configurable on purpose.
--  * Pathway keeps only the state and the impression badge, and shows a message instead of the transcript and evaluation.
--  * Runs every hour (one job, cheap). Also removes interviews that Pathway no longer knows about (for example created and never sent).
--  Additive: one function and one scheduled job; the first run erases nothing today (the oldest interview is days old).
--  Undo: select cron.unschedule('witcher-purge'); drop function public.witcher_purge_old();

create index if not exists interviews_created_at_idx on public.interviews (created_at);

create or replace function public.witcher_purge_old()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted int;
begin
  delete from public.interviews where created_at < now() - interval '1 year';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;
revoke all on function public.witcher_purge_old() from public, anon, authenticated;
grant execute on function public.witcher_purge_old() to service_role;

select cron.schedule('witcher-purge', '17 * * * *', $$select public.witcher_purge_old()$$);
