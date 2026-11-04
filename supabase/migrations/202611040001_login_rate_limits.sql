-- Durable, atomic login throttling for Vercel serverless instances.
-- Apply only after reviewing/approving the production database migration.
create table if not exists public.login_rate_limits (
  key_hash text primary key
    check (key_hash ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz not null,
  attempts integer not null check (attempts >= 0),
  updated_at timestamptz not null default now()
);

alter table public.login_rate_limits enable row level security;
revoke all on table public.login_rate_limits from anon, authenticated;
grant select, insert, update, delete on table public.login_rate_limits to service_role;

create or replace function public.consume_login_rate_limit(
  p_key_hash text,
  p_window_seconds integer default 900,
  p_max_attempts integer default 5
)
returns table (allowed boolean, retry_after_seconds integer, attempts integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_started timestamptz;
  v_attempts integer;
  v_retry integer;
begin
  if p_key_hash is null or p_key_hash !~ '^[a-f0-9]{64}$'
     or p_window_seconds < 60 or p_window_seconds > 86400
     or p_max_attempts < 1 or p_max_attempts > 20 then
    raise exception 'invalid rate limit parameters';
  end if;

  insert into public.login_rate_limits as current (
    key_hash, window_started_at, attempts, updated_at
  )
  values (p_key_hash, v_now, 1, v_now)
  on conflict (key_hash) do update
    set window_started_at = case
          when current.window_started_at <= v_now - make_interval(secs => p_window_seconds)
          then v_now else current.window_started_at end,
        attempts = case
          when current.window_started_at <= v_now - make_interval(secs => p_window_seconds)
          then 1 else current.attempts + 1 end,
        updated_at = v_now
  returning current.window_started_at, current.attempts
    into v_started, v_attempts;

  v_retry := greatest(0, ceil(extract(epoch from
    (v_started + make_interval(secs => p_window_seconds) - v_now)
  ))::integer);

  return query select (v_attempts <= p_max_attempts), 
    case when v_attempts <= p_max_attempts then 0 else v_retry end,
    v_attempts;
end;
$$;

revoke all on function public.consume_login_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_login_rate_limit(text, integer, integer) to service_role;

-- Periodic cleanup can delete rows older than 24 hours; do not run cleanup on every login.
