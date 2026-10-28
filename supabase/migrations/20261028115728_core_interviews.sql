-- Witcher core: interviews, transcript messages, keep-alive ping and sweep.
-- Browser roles (anon, authenticated) get NO access to the tables: only the edge functions (service_role) read and write them.
-- Audio is never stored anywhere; interview_messages holds text only.

-- ---------------------------------------------------------------------------------------------------------------
-- Keep-alive: a public, read-only function the daily GitHub workflow calls so the free projects are not paused.
create or replace function public.witcher_ping()
returns text
language sql
stable
set search_path = ''
as $$ select 'ok'::text $$;

revoke all on function public.witcher_ping() from public;
grant execute on function public.witcher_ping() to anon, authenticated, service_role;

create or replace function public.witcher_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- ---------------------------------------------------------------------------------------------------------------
create table public.interviews (
  id uuid primary key default gen_random_uuid(),
  -- Secret part of the public interview link; the id above is only used by the API clients (Pathway).
  link_id uuid not null unique default gen_random_uuid(),
  source text not null default 'pathway' check (source in ('pathway', 'standalone')),
  -- The caller's own id for this invitation. (source, external_id) is unique so a retried create never duplicates.
  external_id text not null check (char_length(external_id) between 1 and 200),
  candidate_name text not null check (char_length(candidate_name) between 1 and 120),
  candidate_email text not null check (char_length(candidate_email) between 3 and 254 and candidate_email = lower(candidate_email)),
  job_title text not null check (char_length(job_title) between 1 and 120),
  role_title text check (role_title is null or char_length(role_title) <= 120),
  company_name text not null check (char_length(company_name) between 1 and 80),
  brand_color text check (brand_color is null or brand_color ~ '^#[0-9a-fA-F]{6}$'),
  logo_url text check (logo_url is null or (logo_url ~ '^https://' and char_length(logo_url) <= 500)),
  -- Copy of the job's questions at invitation time; later edits to the job do not change an interview already sent.
  questions jsonb not null check (jsonb_typeof(questions) = 'array' and jsonb_array_length(questions) between 1 and 5),
  status text not null default 'created'
    check (status in ('created', 'invited', 'in_progress', 'completed', 'cancelled', 'abandoned', 'expired')),
  -- Access code (6 digits, e-mailed): only a salted hash is stored. Five wrong tries lock the interview for a while.
  code_salt text,
  code_hash text,
  code_attempts int not null default 0,
  code_locked_until timestamptz,
  invite_count int not null default 0,
  last_invite_at timestamptz,
  -- One active browser session at a time (hash of a random token).
  session_hash text,
  session_expires_at timestamptz,
  consent_version text,
  consent_at timestamptz,
  expires_at timestamptz not null default (now() + interval '7 days'),
  -- Where the candidate is: question number (0-based) and whether the next answer is to the question or its follow-up.
  q_index int not null default 0 check (q_index >= 0),
  phase text not null default 'question' check (phase in ('question', 'followup')),
  step_started_at timestamptz,
  started_at timestamptz,
  last_seen_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  abandoned_at timestamptz,
  -- true when an answer was not in English (forces a negative impression, decision 2026-10-27).
  language_flag boolean not null default false,
  evaluation text check (evaluation is null or char_length(evaluation) <= 6000),
  impression text check (impression in ('positive', 'negative')),
  -- Result notification to the client (webhook), delivered later by the integration phase.
  notify_event text check (notify_event in ('completed', 'abandoned', 'expired')),
  notify_state text check (notify_state in ('pending', 'sent', 'failed')),
  notify_attempts int not null default 0,
  notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, external_id)
);

create index interviews_status_expires_idx on public.interviews (status, expires_at);
create index interviews_in_progress_seen_idx on public.interviews (last_seen_at) where status = 'in_progress';
create index interviews_notify_pending_idx on public.interviews (created_at) where notify_state = 'pending';
create index interviews_session_hash_idx on public.interviews (session_hash) where session_hash is not null;

create trigger interviews_set_updated_at
before update on public.interviews
for each row execute function public.witcher_set_updated_at();

create table public.interview_messages (
  id uuid primary key default gen_random_uuid(),
  interview_id uuid not null references public.interviews (id) on delete cascade,
  seq int not null check (seq >= 1),
  role text not null check (role in ('ai', 'candidate')),
  kind text not null check (kind in ('question', 'followup', 'answer', 'closing')),
  -- Transcript (or the AI's text). Null for a skipped answer.
  body text check (body is null or char_length(body) <= 8000),
  audio_seconds int check (audio_seconds is null or audio_seconds between 0 and 600),
  answer_status text check (answer_status in ('submitted', 'skipped')),
  created_at timestamptz not null default now(),
  unique (interview_id, seq)
);

alter table public.interviews enable row level security;
alter table public.interview_messages enable row level security;
revoke all on public.interviews from public, anon, authenticated;
revoke all on public.interview_messages from public, anon, authenticated;
grant all on public.interviews to service_role;
grant all on public.interview_messages to service_role;

comment on table public.interviews is 'AI interviews. No browser access: only edge functions (service_role). Audio is never stored.';
comment on table public.interview_messages is 'Interview transcript (text only). Deleted when the interview is cancelled or abandoned.';

-- ---------------------------------------------------------------------------------------------------------------
-- Records a wrong access code atomically; returns the attempts so far and, when the limit is reached, the lock end.
create or replace function public.witcher_code_failure(p_id uuid, p_max int, p_lock_seconds int)
returns table (attempts int, locked_until timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  update public.interviews i
     set code_attempts = case when i.code_attempts + 1 >= p_max then 0 else i.code_attempts + 1 end,
         code_locked_until = case when i.code_attempts + 1 >= p_max then now() + make_interval(secs => p_lock_seconds) else i.code_locked_until end
   where i.id = p_id
  returning i.code_attempts + 0 as attempts, i.code_locked_until;
end
$$;

-- An interview that was left mid-way is cancelled for good: the transcript is deleted, only the fact that the
-- candidate left (status and date) is kept.
create or replace function public.witcher_abandon(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed int;
begin
  update public.interviews
     set status = 'abandoned', abandoned_at = now(), notify_event = 'abandoned', notify_state = 'pending',
         session_hash = null, session_expires_at = null
   where id = p_id and status = 'in_progress';
  get diagnostics changed = row_count;
  if changed > 0 then
    delete from public.interview_messages where interview_id = p_id;
    return true;
  end if;
  return false;
end
$$;

-- Runs every minute: abandons interviews with no sign of life and expires invitations nobody used.
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

  return jsonb_build_object('abandoned', abandoned, 'expired', expired);
end
$$;

revoke all on function public.witcher_code_failure(uuid, int, int) from public, anon, authenticated;
revoke all on function public.witcher_abandon(uuid) from public, anon, authenticated;
revoke all on function public.witcher_sweep(int) from public, anon, authenticated;
grant execute on function public.witcher_code_failure(uuid, int, int) to service_role;
grant execute on function public.witcher_abandon(uuid) to service_role;
grant execute on function public.witcher_sweep(int) to service_role;
